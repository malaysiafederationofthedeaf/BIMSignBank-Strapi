import { errors } from '@strapi/utils';
const { ValidationError } = errors;
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../../../../utils/r2Client'; // adjust relative path

const TARGET_WIDTH = 350;
const WEBP_QUALITY = 50;
const VALID_INPUT_EXT = /\.(jpe?g|png|webp)$/i;
const BUCKET = process.env.R2_BUCKET || 'mfd-signbank-images';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

// ----- Helpers -----

// Shared slug for vocab images (must match frontend Store.slugPerkataan)
function slugPerkataan(vocabName: string): string {
  return vocabName
    .trim()
    .replace(/[!/]/g, "-")        // legacy: '!' and '/' -> '-'
    .replace(/\?/g, "")           // legacy: remove '?'
    .replace(/[<>:"\|*]/g, "")   // extra safety for Windows filenames
    .replace(/[. ]+$/g, "");      // strip trailing '.' / spaces
}

function isPublished(entry: any) {
  return !!entry.publishedAt;
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
  baseNameSafe: string,
  index: number
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
      `[bim lifecycles] Skipping unsupported image type "${ext}" for file ${originalName}`
    );
    return null;
  }

  const tmpDir = await ensureTmpDir(strapi);

  // If multiple images, add -1, -2, etc.
  const indexSuffix = index > 0 ? `-${index + 1}` : '';
  const outputFileName = `${baseNameSafe}${indexSuffix}.webp`;
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
  const key = `vocab/${outputFileName}`;

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
      `[bim lifecycles] Uploaded to R2 bucket=${bucket} key=${key}`
    );
  } catch (err) {
    strapi.log.error('[bim lifecycles] Failed to upload to R2 via API', err);
    throw err; // re-throw to be caught in handleImages and trigger ValidationError
  }
}

async function deleteFromR2(strapi: any, outputFileName: string) {
  const bucket = process.env.R2_BUCKET || 'mfd-signbank-images';
  const key = `vocab/${outputFileName}`;

  try {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    strapi.log.info(
      `[bim lifecycles] Deleted from R2 bucket=${bucket} key=${key}`
    );
  } catch (err) {
    strapi.log.error('[bim lifecycles] Failed to delete from R2 via API', err);
  }
}

// ----- Main handler -----

async function handleImages(strapi: any, entryId: number, rawResult?: any) {
  strapi.log.info(`[bim lifecycles] handleImages called for entry ${entryId}`);

  // Start from rawResult, but if Image is missing/null, re-fetch with populate
  let entry = rawResult;

  if (!entry || entry.Image == null) {
    entry = await strapi.entityService.findOne('api::bim.bim', entryId, {
      populate: { Image: true },
    });
  }

  if (!entry) {
    strapi.log.info('[bim lifecycles] entry missing');
    return;
  }

  const vocabName = entry.Perkataan;
  if (!vocabName) {
    strapi.log.warn(
      '[bim lifecycles] Perkataan is missing, skipping image processing'
    );
    return;
  }

  const baseNameSafe = slugPerkataan(vocabName);

  let images = entry.Image;
  if (!images) {
    strapi.log.info(
      `[bim lifecycles] Image field at runtime: ${JSON.stringify(
        entry.Image
      )}`
    );
    strapi.log.info('[bim lifecycles] No Image attached, skipping');
    return;
  }

  if (!Array.isArray(images)) {
    images = [images];
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || !img.url) continue;

    try {
      const webpInfo = await compressToWebp(strapi, img, baseNameSafe, i);
      if (!webpInfo) {
        // Unsupported or failed compression → treat as failure for this image
        throw new Error('Image compression failed or unsupported format.');
      }

      const { outputFileName, tmpOutputPath } = webpInfo;

      await uploadToR2(strapi, outputFileName, tmpOutputPath);

      await strapi.entityService.update('plugin::upload.file', img.id, {
        data: {
          name: outputFileName,
          alternativeText: vocabName,
          caption: vocabName,
        },
      });
    } catch (err) {
      strapi.log.error('[bim lifecycles] Image processing failed', err);
      // An image WAS attached, but processing failed → surface a blocking error
      throw new ValidationError(
        'Image upload/compression for this BIM entry failed. Please try again with a different image or try again later.'
      );
    }
  }
}

async function deleteImagesFromR2(strapi: any, entryId: number) {
  strapi.log.info(
    `[bim lifecycles] deleteImagesFromR2 called for entry ${entryId}`
  );

  const entry = await strapi.entityService.findOne('api::bim.bim', entryId, {
    populate: { Image: true },
  });

  if (!entry) {
    strapi.log.info('[bim lifecycles] entry missing on delete');
    return;
  }

  const vocabName = entry.Perkataan;
  if (!vocabName) {
    strapi.log.warn(
      '[bim lifecycles] Perkataan missing on delete, skipping R2 cleanup'
    );
    return;
  }

  // Use the same naming rule as handleImages
  const baseNameSafe = slugPerkataan(vocabName);

  let images = entry.Image;
  if (!images) {
    strapi.log.info('[bim lifecycles] No Image attached on delete');
    return;
  }

  if (!Array.isArray(images)) {
    images = [images];
  }

  for (let i = 0; i < images.length; i++) {
    const indexSuffix = i > 0 ? `-${i + 1}` : '';
    const outputFileName = `${baseNameSafe}${indexSuffix}.webp`;
    await deleteFromR2(strapi, outputFileName);
  }
}

function hasAtLeastOneImage(imageField: any): boolean {
  if (!imageField) return false;
  if (Array.isArray(imageField)) return imageField.length > 0;
  return true; // single image case
}

async function validateImagesOrThrow(strapi: any, params: any) {
  const data = params?.data || {};
  const perkataan = data.Perkataan;

  if (typeof perkataan === 'string') {
    // Block characters that we know cause issues across the stack:
    //  - %: can break decodeURIComponent if not properly encoded
    //  - \: has caused image / routing / DB weirdness
    const forbiddenPattern = /[%\\]/g;
    const matches = perkataan.match(forbiddenPattern);

    if (matches) {
      const unique = Array.from(new Set(matches));
      throw new ValidationError(
        `Perkataan contains unsupported characters: ${unique.join(
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
      `[bim lifecycles] beforeCreate called with data=${JSON.stringify(
        event.params.data
      )}`
    );
    await validateImagesOrThrow(strapi, event.params);
  },

  async beforeUpdate(event: any) {
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

    // If this update is ONLY changing Image_Public_URL, skip image handling
    const data = params?.data || {};
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === 'Image_Public_URL') {
      strapi.log.info(
        `[bim lifecycles] afterUpdate: only Image_Public_URL changed, skipping handleImages for entry ${result.id}`
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
        '[bim lifecycles] beforeDelete called without simple id; skipping R2 cleanup'
      );
      return;
    }

    await deleteImagesFromR2(strapi, Number(id));
  },
};