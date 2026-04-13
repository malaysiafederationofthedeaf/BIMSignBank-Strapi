'use strict';

const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const TARGET_WIDTH = 350;
const WEBP_QUALITY = 50;
const VALID_INPUT_EXT = /\.(jpe?g|png)$/i;
const BUCKET = process.env.R2_BUCKET || 'mfd-signbank-images';

// ----- Helpers -----

function sanitizeName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function isPublished(entry) {
  return !!entry.publishedAt;
}

function getUploadsRoot(strapi) {
  // Strapi serves uploads from <project>/public/uploads
  return strapi.dirs.static.public;
}

function getExtFromName(name) {
  const match = name.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

async function ensureTmpDir(strapi) {
  const tmpDir = path.join(strapi.dirs.app.root, '.tmp', 'r2');
  await fs.mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

async function compressToWebp(strapi, uploadFile, baseNameSafe, index) {
  const uploadsRoot = getUploadsRoot(strapi);
  const absoluteInputPath = path.join(uploadsRoot, uploadFile.url);

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

async function uploadToR2(strapi, outputFileName, tmpOutputPath) {
  const objectPath = `${BUCKET}/vocab/${outputFileName}`;
  const cmd = `npx wrangler r2 object put "${objectPath}" --file "${tmpOutputPath}" --remote`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: strapi.dirs.app.root,
      env: process.env,
    });

    if (stdout) strapi.log.info(`[bim lifecycles] R2 upload stdout: ${stdout}`);
    if (stderr) strapi.log.warn(`[bim lifecycles] R2 upload stderr: ${stderr}`);
  } catch (err) {
    strapi.log.error('[bim lifecycles] Failed to upload to R2', err);
  }
}

// ----- Main handler -----

async function handleImages(strapi, entryId) {
  // Re-fetch with media populated to be safe
  const entry = await strapi.entityService.findOne('api::bim.bim', entryId, {
    populate: { Image: true },
  });

  if (!entry || !isPublished(entry)) return;

  const vocabName = entry.Perkataan;
  if (!vocabName) {
    strapi.log.warn('[bim lifecycles] Perkataan is missing, skipping image processing');
    return;
  }

  const baseNameSafe = sanitizeName(vocabName);

  let images = entry.Image;
  if (!images) {
    strapi.log.info('[bim lifecycles] No Image attached, skipping');
    return;
  }

  // Image field is multiple: true → normalize to array
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

    // Optionally: rename the Upload file record to match vocab name
    try {
      await strapi.entityService.update('plugin::upload.file', img.id, {
        data: {
          name: outputFileName,
          alternativeText: vocabName,
          caption: vocabName,
        },
      });
    } catch (err) {
      strapi.log.error('[bim lifecycles] Failed to update upload file record', err);
    }
  }
}

// ----- Lifecycles -----

module.exports = {
  async afterCreate(event) {
    const { result } = event;
    if (!result || !result.id) return;
    await handleImages(strapi, result.id);
  },

  async afterUpdate(event) {
    const { result } = event;
    if (!result || !result.id) return;
    await handleImages(strapi, result.id);
  },
};