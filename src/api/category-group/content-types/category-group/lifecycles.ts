import { errors } from '@strapi/utils';
const { ValidationError } = errors;
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../../../../utils/r2Client'; // adjust relative path

// Category-group images mirror the vocab (BIM) image pipeline, but:
//   - the slug is built from KumpulanKategori (not Perkataan)
//   - R2 keys live under the `category/` prefix (not `vocab/`)
//   - a category has AT MOST ONE image (schema: Image is media, multiple:false)
// See src/api/bim/content-types/bim/lifecycles.ts for the original.

const TARGET_WIDTH = 350;
const WEBP_QUALITY = 50;
const VALID_INPUT_EXT = /\.(jpe?g|png|webp)$/i;
const BUCKET = process.env.R2_BUCKET || 'mfd-signbank-images';

// ----- Helpers -----

// Shared slug for category images.
// IMPORTANT: this must match the equivalent slug function on the frontend
// (the vocab pipeline pairs slugPerkataan here with Store.slugPerkataan on the
// frontend; the frontend needs a matching slug for KumpulanKategori before it
// can resolve these category/<slug>.webp URLs).
//
// The webp filename is built from the CATEGORY name only -- the part after "/"
// in KumpulanKategori. The group is intentionally NOT included, so the R2
// object for "Alam/Haiwan" is category/Haiwan.webp (not category/Alam-Haiwan.webp),
// matching the files the frontend already requests. Spaces, "&" and case are
// preserved (they are URL-encoded when fetched).
function slugKumpulanKategori(categoryName: string): string {
  const categoryOnly = categoryName.includes("/")
    ? categoryName.split("/").pop() || categoryName
    : categoryName;
  return categoryOnly
    .trim()
    .replace(/!/g, "-")           // legacy: '!' -> '-'
    .replace(/\?/g, "")           // legacy: remove '?'
    .replace(/[<>:"\|*]/g, "")   // extra safety for Windows filenames
    .replace(/[. ]+$/g, "");      // strip trailing '.' / spaces
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getUploadsRoot(strapi: any) {
  // Strapi serves uploads from <project>/public/uploads
  return strapi.dirs.static.public;
}

function getExtFromName(name: string) {
  const match = name.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

async function ensureTmpDir(strapi: any) {
  const tmpDir = path.join(strapi.dirs.app.root, '.tmp', 'r2');
  await fs.mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

async function compressToWebp(
  strapi: any,
  uploadFile: any,
  baseNameSafe: string
) {
  const uploadsRoot = getUploadsRoot(strapi);

  // IMPORTANT: remove leading slash so path.join works correctly
  const relativeUrl = uploadFile.url.startsWith('/')
    ? uploadFile.url.slice(1)
    : uploadFile.url;

  const absoluteInputPath = path.join(uploadsRoot, relativeUrl);

  const originalName = uploadFile.name || '';
  const ext = getExtFromName(originalName);

  if (!VALID_INPUT_EXT.test('.' + ext)) {
    strapi.log.warn(
      `[category-group lifecycles] Skipping unsupported image type "${ext}" for file ${originalName}`
    );
    return null;
  }

  const tmpDir = await ensureTmpDir(strapi);

  // A category has a single image, so there is no index suffix.
  const outputFileName = `${baseNameSafe}.webp`;
  const tmpOutputPath = path.join(tmpDir, outputFileName);

  await sharp(absoluteInputPath)
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(tmpOutputPath);

  return { outputFileName, tmpOutputPath };
}

async function uploadToR2(
  strapi: any,
  outputFileName: string,
  tmpOutputPath: string
) {
  const bucket = process.env.R2_BUCKET || 'mfd-signbank-images';
  const key = `category/${outputFileName}`;

  try {
    const fileBuffer = await fs.readFile(tmpOutputPath);

    await r2Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: 'image/webp',
      })
    );

    strapi.log.info(
      `[category-group lifecycles] Uploaded to R2 bucket=${bucket} key=${key}`
    );
  } catch (err) {
    strapi.log.error('[category-group lifecycles] Failed to upload to R2 via API', err);
    throw err; // re-throw to be caught in handleImages and trigger ValidationError
  }
}

// Delete all R2 images for a single category slug.
//
// This removes every object whose key matches:
//   category/<slug>.webp
//   category/<slug>-<number>.webp   (defensive: covers stray numbered files)
// It is used by:
//   - handleImages(...) when reprocessing the image for a category
//   - deleteImagesFromR2(...) when we decide it's safe to fully
//     clean up R2 for a category that is being deleted.
async function deleteAllR2ImagesForSlug(strapi: any, baseNameSafe: string) {
  const bucket = process.env.R2_BUCKET || 'mfd-signbank-images';
  const prefix = `category/${baseNameSafe}`;
  // Only match keys of the form:
  //   category/<slug>.webp
  //   category/<slug>-<number>.webp
  const baseRe = new RegExp(
    `^category/${escapeRegExp(baseNameSafe)}(?:\\.webp|-[0-9]+\\.webp)$`
  );

  try {
    const resp = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      })
    );

    const contents = resp.Contents || [];
    if (!contents.length) {
      strapi.log.info(
        `[category-group lifecycles] No existing R2 category images found for slug=${baseNameSafe}`
      );
      return;
    }

    for (const obj of contents) {
      if (!obj.Key) continue;
      if (!baseRe.test(obj.Key)) {
        // Key starts with category/<slug> but doesn't match our exact pattern → skip
        continue;
      }
      try {
        await r2Client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: obj.Key,
          })
        );
        strapi.log.info(
          `[category-group lifecycles] Deleted old R2 category image bucket=${bucket} key=${obj.Key}`
        );
      } catch (err) {
        strapi.log.error(
          `[category-group lifecycles] Failed to delete old R2 category image key=${obj.Key}`,
          err
        );
      }
    }
  } catch (err) {
    strapi.log.error(
      `[category-group lifecycles] Failed to list existing R2 category images for slug=${baseNameSafe}`,
      err
    );
  }
}

// Rename (move) all R2 images from one category slug to another.
//
// When KumpulanKategori changes, we compute oldSlug/newSlug and call this
// to move all objects:
//   category/<oldSlug>.webp
// to:
//   category/<newSlug>.webp
// This keeps R2 keys aligned with the current KumpulanKategori slug.
async function renameR2ImagesForSlug(
  strapi: any,
  oldBaseNameSafe: string,
  newBaseNameSafe: string
) {
  if (!oldBaseNameSafe || !newBaseNameSafe || oldBaseNameSafe === newBaseNameSafe) {
    return;
  }

  const bucket = process.env.R2_BUCKET || 'mfd-signbank-images';
  const oldPrefix = `category/${oldBaseNameSafe}`;
  const baseRe = new RegExp(
    `^category/${escapeRegExp(oldBaseNameSafe)}(?:\\.webp|-[0-9]+\\.webp)$`
  );

  try {
    const resp = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: oldPrefix,
      })
    );

    const contents = resp.Contents || [];
    if (!contents.length) {
      strapi.log.info(
        `[category-group lifecycles] No existing R2 category images found to rename for slug=${oldBaseNameSafe}`
      );
      return;
    }

    for (const obj of contents) {
      if (!obj.Key) continue;
      const key = obj.Key as string;
      if (!baseRe.test(key)) {
        // Key starts with category/<oldSlug> but doesn't match our exact pattern
        continue;
      }

      const suffix = key.slice(`category/${oldBaseNameSafe}`.length);
      const newKey = `category/${newBaseNameSafe}${suffix}`;

      try {
        await r2Client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${key}`,
            Key: newKey,
          })
        );
        await r2Client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
        strapi.log.info(
          `[category-group lifecycles] Renamed R2 category image bucket=${bucket} key=${key} -> ${newKey}`
        );
      } catch (err) {
        strapi.log.error(
          `[category-group lifecycles] Failed to rename R2 category image key=${key} -> ${newKey}`,
          err
        );
      }
    }
  } catch (err) {
    strapi.log.error(
      `[category-group lifecycles] Failed to list R2 category images for rename from slug=${oldBaseNameSafe} to slug=${newBaseNameSafe}`,
      err
    );
  }
}

// After the image is on R2, detach the Strapi media relation and delete the
// local upload file. We deliberately do NOT persist a public URL: the R2 key
// is deterministic (category/<slug>.webp), so consumers rebuild the URL from
// KumpulanKategori the same way the frontend derives vocab image URLs.
async function clearRelationAndCleanup(
  strapi: any,
  entryId: number,
  images: any[]
) {
  // 1) Detach the Image relation on the category-group entry
  try {
    await strapi.entityService.update('api::category-group.category-group', entryId, {
      data: {
        Image: null, // detach Strapi upload relation
      },
    });
    strapi.log.info(
      `[category-group lifecycles] Cleared Image relation for entry ${entryId}`
    );
  } catch (err) {
    strapi.log.error(
      `[category-group lifecycles] Failed to clear Image relation for entry ${entryId}`,
      err
    );
  }

  // 2) Delete upload plugin files (removes files from public/uploads)
  for (const img of images) {
    if (!img || !img.id) continue;
    try {
      await strapi.entityService.delete('plugin::upload.file', img.id);
      strapi.log.info(
        `[category-group lifecycles] Deleted local upload file plugin::upload.file id=${img.id}`
      );
    } catch (err) {
      strapi.log.error(
        `[category-group lifecycles] Failed to delete local upload file id=${img.id}`,
        err
      );
    }
  }
}

// ----- Main handler -----
// Main image handler used afterCreate/afterUpdate.
//
// Workflow for a category that has an image:
//   - Compress the original upload to WebP and upload to R2 using the
//     KumpulanKategori-based slug (category/<slug>.webp).
//   - Before uploading a new image for a category, call
//     deleteAllR2ImagesForSlug(...) to remove older R2 variants.
//   - Clear the Image relation so R2 + the slug become the source of truth
//     for the image (no stored URL; consumers derive it from the slug).
async function handleImages(strapi: any, entryId: number, rawResult?: any) {
  strapi.log.info(`[category-group lifecycles] handleImages called for entry ${entryId}`);

  // Start from rawResult, but if Image is missing/null, re-fetch with populate
  let entry = rawResult;

  if (!entry || entry.Image == null) {
    entry = await strapi.entityService.findOne('api::category-group.category-group', entryId, {
      populate: { Image: true },
    });
  }

  if (!entry) {
    strapi.log.info('[category-group lifecycles] entry missing');
    return;
  }

  const categoryName = entry.KumpulanKategori;
  if (!categoryName) {
    strapi.log.warn(
      '[category-group lifecycles] KumpulanKategori is missing, skipping image processing'
    );
    return;
  }

  const baseNameSafe = slugKumpulanKategori(categoryName);

  let images = entry.Image;
  if (!images) {
    strapi.log.info(
      `[category-group lifecycles] Image field at runtime: ${JSON.stringify(
        entry.Image
      )}`
    );
    strapi.log.info('[category-group lifecycles] No Image attached, skipping');
    return;
  }

  // Image is a single-media relation (multiple:false), but normalize
  // defensively so the processing loop is identical to the vocab pipeline.
  if (!Array.isArray(images)) {
    images = [images];
  }

  if (!images.length) {
    strapi.log.info('[category-group lifecycles] Image array empty, skipping');
    return;
  }

  // >>> CLEANUP ONLY WHEN WE HAVE IMAGES <<<
  await deleteAllR2ImagesForSlug(strapi, baseNameSafe);

  let processedAny = false;

  for (const img of images) {
    if (!img || !img.url) continue;

    try {
      const webpInfo = await compressToWebp(strapi, img, baseNameSafe);
      if (!webpInfo) {
        throw new Error('Image compression failed or unsupported format.');
      }

      const { outputFileName, tmpOutputPath } = webpInfo;

      await uploadToR2(strapi, outputFileName, tmpOutputPath);

      try {
        await fs.unlink(tmpOutputPath);
      } catch (err) {
        strapi.log.warn(
          '[category-group lifecycles] Failed to delete temp WebP file',
          err
        );
      }

      await strapi.entityService.update('plugin::upload.file', img.id, {
        data: {
          alternativeText: categoryName,
          caption: categoryName,
        },
      });

      processedAny = true;
    } catch (err) {
      strapi.log.error('[category-group lifecycles] Image processing failed', err);
      throw new ValidationError(
        'Image upload/compression for this Category Group failed. Please try again with a different image or try again later.'
      );
    }
  }

  if (processedAny) {
    const categoryId = entry.id || entryId;
    await clearRelationAndCleanup(strapi, categoryId, images);
  }
}

// High-level R2 cleanup used by beforeDelete.
//
// Given a category-group entry id:
//   1) Look up the entry and its KumpulanKategori/documentId.
//   2) Check for any *other* category-group entries that share the same
//      documentId (preferred) or KumpulanKategori.
//   3) If any siblings still exist, SKIP deleting R2 images so
//      draft/published copies don't wipe each other's data.
//   4) Only when this is the *last* entry for that category/document
//      do we call deleteAllR2ImagesForSlug(...) to remove all R2
//      images for that slug.
async function deleteImagesFromR2(strapi: any, entryId: number) {
  strapi.log.info(
    `[category-group lifecycles] deleteImagesFromR2 called for entry ${entryId}`
  );

  const entry = await strapi.entityService.findOne('api::category-group.category-group', entryId, {
    populate: {}, // no need for Image
  });

  if (!entry) {
    strapi.log.info('[category-group lifecycles] entry missing on delete');
    return;
  }

  const categoryName = entry.KumpulanKategori;
  if (!categoryName) {
    strapi.log.warn(
      '[category-group lifecycles] KumpulanKategori missing on delete, skipping R2 cleanup'
    );
    return;
  }

  const baseNameSafe = slugKumpulanKategori(categoryName);

  // Prefer grouping by documentId (draft/publish siblings share this)
  const docId = (entry as any).documentId;

  const filters: any = docId
    ? { documentId: docId }
    : { KumpulanKategori: categoryName };

  // Find any other category-group entries that belong to the same logical category
  const siblings = await strapi.entityService.findMany('api::category-group.category-group', {
    filters,
    fields: ['id', 'KumpulanKategori', 'documentId'],
    limit: 10, // small safety cap
  });

  const others = siblings.filter((e: any) => e.id !== entryId);

  if (others.length > 0) {
    strapi.log.info(
      `[category-group lifecycles] Another category-group entry for this category/document still exists (e.g. id=${others[0].id}); skipping R2 delete for slug=${baseNameSafe}`
    );
    return;
  }

  // This is the last entry for this category/document → safe to delete its R2 images
  await deleteAllR2ImagesForSlug(strapi, baseNameSafe);
}

async function validateImagesOrThrow(strapi: any, params: any) {
  const data = params?.data || {};
  const kumpulanKategori = data.KumpulanKategori;

  if (typeof kumpulanKategori === 'string') {
    // Block characters that we know cause issues across the stack:
    //  - %: can break decodeURIComponent if not properly encoded
    //  - \: has caused image / routing / DB weirdness
    const forbiddenPattern = /[%\\]/g;
    const matches = kumpulanKategori.match(forbiddenPattern);

    if (matches) {
      const unique = Array.from(new Set(matches));
      throw new ValidationError(
        `KumpulanKategori contains unsupported characters: ${unique.join(
          ' '
        )}. Please remove these characters before saving.`
      );
    }
  }

  // Add more rules later if needed.
}

// ----- Lifecycles -----

export default {
  async beforeCreate(event: any) {
    strapi.log.info(
      `[category-group lifecycles] beforeCreate called with data=${JSON.stringify(
        event.params.data
      )}`
    );
    await validateImagesOrThrow(strapi, event.params);
  },

  // beforeUpdate:
  // - Validates KumpulanKategori as usual.
  // - Detects when KumpulanKategori is being changed for an existing entry.
  // - On KumpulanKategori change:
  //     * Computes old and new slugs using slugKumpulanKategori.
  //     * Calls renameR2ImagesForSlug(...) to move the R2 image
  //       from category/<oldSlug>.webp to category/<newSlug>.webp.
  // - Then runs validateImagesOrThrow(...) as normal.
  async beforeUpdate(event: any) {
    const where = event?.params?.where;
    const id =
      typeof where?.id === 'number' || typeof where?.id === 'string'
        ? Number(where.id)
        : null;

    if (id) {
      try {
        const existing = await strapi.entityService.findOne('api::category-group.category-group', id, {
          fields: ['KumpulanKategori'],
        });

        const data = event.params?.data || {};
        const newKumpulanKategori = data.KumpulanKategori;

        if (
          existing &&
          typeof existing.KumpulanKategori === 'string' &&
          typeof newKumpulanKategori === 'string' &&
          existing.KumpulanKategori !== newKumpulanKategori
        ) {
          const oldSlug = slugKumpulanKategori(existing.KumpulanKategori);
          const newSlug = slugKumpulanKategori(newKumpulanKategori);

          if (oldSlug !== newSlug) {
            // Move the R2 object to the new slug. There is no stored URL to
            // update: consumers derive category/<newSlug>.webp from the slug.
            await renameR2ImagesForSlug(strapi, oldSlug, newSlug);
          }
        }
      } catch (err) {
        strapi.log.error(
          `[category-group lifecycles] Failed during KumpulanKategori rename handling in beforeUpdate for entry id=${id}`,
          err
        );
      }
    }

    await validateImagesOrThrow(strapi, event.params);
  },

  async afterCreate(event: any) {
    const { result } = event;
    if (!result || !result.id) return;
    await handleImages(strapi, result.id, result);
  },

  async afterUpdate(event: any) {
    const { result, params } = event;
    if (!result || !result.id) return;

    // Skip our own post-processing update that only detaches the Image
    // relation ({ Image: null }); otherwise we'd re-run handleImages
    // needlessly right after clearing the relation.
    const data = params?.data || {};
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === 'Image' && data.Image === null) {
      strapi.log.info(
        `[category-group lifecycles] afterUpdate: only Image relation cleared, skipping handleImages for entry ${result.id}`
      );
      return;
    }

    await handleImages(strapi, result.id, result);
  },

  async beforeDelete(event: any) {
    const where = event?.params?.where;
    const id =
      typeof where?.id === 'number' || typeof where?.id === 'string'
        ? where.id
        : null;

    if (!id) {
      strapi.log.warn(
        '[category-group lifecycles] beforeDelete called without simple id; skipping R2 cleanup'
      );
      return;
    }

    await deleteImagesFromR2(strapi, Number(id));
  },
};
