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

// ----- Helpers -----

function sanitizeName(name: string) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
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

  const baseNameSafe = sanitizeName(vocabName);

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

    const webpInfo = await compressToWebp(strapi, img, baseNameSafe, i);
    if (!webpInfo) continue;

    const { outputFileName, tmpOutputPath } = webpInfo;

    await uploadToR2(strapi, outputFileName, tmpOutputPath);

    try {
      await strapi.entityService.update('plugin::upload.file', img.id, {
        data: {
          name: outputFileName,
          alternativeText: vocabName,
          caption: vocabName,
        },
      });
    } catch (err) {
      strapi.log.error(
        '[bim lifecycles] Failed to update upload file record',
        err
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

  const baseNameSafe = sanitizeName(vocabName);

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
  const { data, where } = params;

  // CREATE: data.Image must contain at least one image
  if (!where) {
    if (!hasAtLeastOneImage(data.Image)) {
      throw new ValidationError(
        'Please attach at least one JPEG/PNG/WEBP image before saving this BIM entry.'
      );
    }
    return;
  }

  // UPDATE: only validate if Image is being changed explicitly
  if ('Image' in data) {
    if (!hasAtLeastOneImage(data.Image)) {
      throw new ValidationError(
        'Please attach at least one JPEG/PNG/WEBP image before saving this BIM entry.'
      );
    }
  }
}

// ----- Lifecycles -----

export default {
  async beforeCreate(event: any) {
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
    const { result } = event;
    if (!result || !result.id) return;
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