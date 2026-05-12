const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');
const FormData = require('form-data');

const SUPPORTED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const httpsAgent = new https.Agent({ keepAlive: true });

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  args.forEach((arg) => {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=') || 'true';
    if (key.startsWith('--')) {
      const rawKey = key.slice(2);
      const camelKey = rawKey.replace(/-([a-z])/g, (_, chr) => chr.toUpperCase());
      const underscoredKey = rawKey.replace(/-/g, '_');
      result[rawKey] = value;
      result[camelKey] = value;
      result[underscoredKey] = value;
    }
  });
  return result;
}

function normalizeHeader(key) {
  return key ? key.toString().trim() : '';
}

function normalizeToken(raw) {
  if (!raw) return '';
  return raw.toString().replace(/\r|\n|\s+/g, '').trim();
}

function normalizeText(raw) {
  return raw ? raw.toString().trim().toLowerCase() : '';
}

function getCsvField(row, candidates) {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined && row[name] !== null && row[name] !== '') {
      return row[name];
    }
  }
  const lowerCandidates = candidates.map((name) => name.toLowerCase());
  for (const key of Object.keys(row)) {
    if (lowerCandidates.includes(key.toLowerCase()) && row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return undefined;
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  let url = rawUrl.toString().trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

function appendRenderToken(urlString, renderToken) {
  if (!renderToken) return urlString;
  const url = new URL(urlString);
  url.searchParams.set('render_token', renderToken);
  return url.href;
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function buildImageMap(imagesPath) {
  const entries = fs.readdirSync(imagesPath, { withFileTypes: true });
  const map = new Map();
  entries.forEach((entry) => {
    if (!entry.isFile()) return;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.includes(ext)) return;
    const base = path.basename(entry.name, ext).trim().toLowerCase();
    if (!base) return;
    if (!map.has(base)) map.set(base, []);
    map.get(base).push(path.join(imagesPath, entry.name));
  });
  return map;
}

function loadRows(csvFile) {
  const csvText = fs.readFileSync(csvFile, 'utf8');
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] !== undefined ? values[idx] : '';
    });
    return row;
  });
}

async function uploadFile(strapiUrl, token, filePath, renderToken) {
  const form = new FormData();
  form.append('files', fs.createReadStream(filePath));
  const url = new URL('/api/upload', strapiUrl).href;
  console.log('Upload endpoint:', url);
  const headers = {
    Authorization: `Bearer ${token}`,
    ...form.getHeaders(),
  };
  if (renderToken) {
    headers['X-Internal-Token'] = renderToken;
  }
  const response = await axios.post(url, form, {
    headers,
    maxBodyLength: Infinity,
    httpsAgent,
    proxy: false,
  });
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error(`Upload returned empty response for file ${filePath}`);
  }
  return response.data[0].id;
}

async function createVocabEntry(strapiUrl, token, data, renderToken) {
  const url = new URL('/api/bims', strapiUrl).href;
  console.log('Create endpoint:', url);
  console.log('Create payload:', JSON.stringify({ data }, null, 2));
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (renderToken) {
    headers['X-Internal-Token'] = renderToken;
  }
  const response = await axios.post(
    url,
    { data },
    {
      headers,
      httpsAgent,
      proxy: false,
    }
  );
  console.log('Create response:', JSON.stringify(response.data, null, 2));
  return response.data;
}

async function getBimEntry(strapiUrl, token, id, renderToken) {
  const singleUrl = new URL(`/api/bims/${id}?populate=category_group`, strapiUrl).href;
  console.log('Fetch BIM entry endpoint:', singleUrl);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    if (renderToken) {
      headers['X-Internal-Token'] = renderToken;
    }
    const response = await axios.get(singleUrl, {
      headers,
      httpsAgent,
      proxy: false,
    });
    console.log('Fetch BIM entry response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (err) {
    console.warn('Single-item fetch failed, trying filtered list fallback:', err.response?.status, err.response?.data?.error?.message || err.message);
    const listUrl = new URL(`/api/bims?filters[id][$eq]=${id}&populate=category_group`, strapiUrl).href;
    console.log('Fetch BIM entry fallback endpoint:', listUrl);
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    if (renderToken) {
      headers['X-Internal-Token'] = renderToken;
    }
    const response = await axios.get(listUrl, {
      headers,
      httpsAgent,
      proxy: false,
    });
    console.log('Fetch BIM entry fallback response:', JSON.stringify(response.data, null, 2));
    return response.data;
  }
}

async function fetchCategoryGroups(strapiUrl, token, renderToken) {
  const url = new URL('/api/category-groups?pagination[pageSize]=1000', strapiUrl).href;
  console.log('Fetching category groups from:', url);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    if (renderToken) {
      headers['X-Internal-Token'] = renderToken;
    }
    const response = await axios.get(url, {
      headers,
      httpsAgent,
      proxy: false,
    });
    console.log('Category groups response:', JSON.stringify(response.data, null, 2));

    const groups = response.data.data || [];
    const map = new Map();
    groups.forEach((group) => {
      const rawName = group.attributes?.KumpulanKategori || group.attributes?.category_group || group.KumpulanKategori || group.category_group || group.attributes?.name || group.name;
      const normalizedName = normalizeText(rawName);
      const id = group.id;
      if (normalizedName) {
        console.log(`Mapping category group: "${rawName}" (ID: ${id}) -> normalized: "${normalizedName}"`);
        map.set(normalizedName, id);
      }
    });
    console.log(`Total category groups mapped: ${map.size}`);
    console.log('Category group map keys:', Array.from(map.keys()));
    return map;
  } catch (err) {
    console.error('Error fetching category groups:', err.response?.data || err.message);
    return new Map();
  }
}

async function main() {
  const args = parseArgs();
  const strapiUrl = normalizeUrl(args.url || process.env.STRAPI_URL || 'https://localhost:1337');
  const token = normalizeToken(args.token || process.env.STRAPI_TOKEN);
  const renderToken = normalizeHeader(args.renderToken || args['render-token'] || args.render_token || process.env.RENDER_TOKEN);
  const csvFile = args.csv || args.excel || process.env.CSV_FILE || process.env.EXCEL_FILE || 'vocabs.csv';
  const imagesFolder = args.images || process.env.IMAGES_FOLDER || 'images';
  const dryRun = args['dry-run'] === 'true' || args['dryRun'] === 'true';

  if (!token) {
    console.error('ERROR: A Strapi API token is required via --token or STRAPI_TOKEN.');
    process.exit(1);
  }

  const absCsv = path.resolve(csvFile);
  const absImages = path.resolve(imagesFolder);

  if (!fs.existsSync(absCsv)) {
    console.error(`ERROR: CSV file not found: ${absCsv}`);
    process.exit(1);
  }
  if (!fs.existsSync(absImages) || !fs.statSync(absImages).isDirectory()) {
    console.error(`ERROR: Images folder not found: ${absImages}`);
    process.exit(1);
  }

  console.log('Using Strapi URL:', strapiUrl);
  console.log('Reading CSV file:', absCsv);
  const rows = loadRows(absCsv);
  const imageMap = buildImageMap(absImages);
  let categoryGroupMap = await fetchCategoryGroups(strapiUrl, token, renderToken);

  // Collect all unique category groups from CSV
  const csvCategoryGroups = new Set();
  rows.forEach((row) => {
    const cat = row.category_group || row.KUMPULANKATEGORI;
    if (cat && cat.trim()) {
      csvCategoryGroups.add(cat.trim());
    }
  });

  for (const groupName of csvCategoryGroups) {
    if (!categoryGroupMap.has(groupName)) {
      console.warn(`Category group "${groupName}" not found in Strapi. It will be skipped for payload assignment.`);
    }
  }

  console.log(`Found ${rows.length} rows, ${imageMap.size} image base names, and ${categoryGroupMap.size} category groups.`);

  if (rows.length === 0) {
    console.log('No rows found in the CSV file. Nothing to upload.');
    return;
  }

  let success = 0;
  let skipped = 0;
  const failures = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowLabel = `Row ${index + 1}`;
    const perkataan = (getCsvField(row, ['Perkataan', 'perkataan']) || '').toString().trim();
    const word = (getCsvField(row, ['Word', 'word']) || '').toString().trim();
    const video = (getCsvField(row, ['Video', 'video']) || '').toString().trim();

    if (!perkataan) {
      console.warn(`${rowLabel}: missing Perkataan, skipping.`);
      skipped += 1;
      continue;
    }
    if (!word) {
      console.warn(`${rowLabel}: missing Word, skipping.`);
      skipped += 1;
      continue;
    }
    if (!video) {
      console.warn(`${rowLabel}: missing Video URL/text, skipping.`);
      skipped += 1;
      continue;
    }

    const payload = {
      Perkataan: perkataan,
      Word: word,
      Video: video,
    };

    const categoryGroupValue = getCsvField(row, ['category_group', 'KUMPULANKATEGORI', 'KumpulanKategori', 'category group']);
    ['Image_Status', 'Video_Status', 'Example_Sentence', 'Contoh_Ayat'].forEach((field) => {
      const value = getCsvField(row, [field, field.toLowerCase()]);
      if (value !== undefined && value !== null && value !== '') {
        payload[field] = value.toString();
      }
    });

    if (categoryGroupValue !== undefined && categoryGroupValue !== null && categoryGroupValue !== '') {
      const lookupKey = normalizeText(categoryGroupValue);
      console.log(`${rowLabel}: Looking up category_group "${categoryGroupValue}" -> normalized "${lookupKey}"`);
      const id = categoryGroupMap.get(lookupKey);
      if (id !== undefined) {
        console.log(`${rowLabel}: Found category_group ID: ${id}`);
        payload.category_group = id;
      } else {
        console.warn(`${rowLabel}: category_group '${categoryGroupValue}' not found in fetched groups.`);
      }
    }

    const imageKey = perkataan.trim().toLowerCase();
    const imagePaths = imageMap.get(imageKey);
    let uploadId = null;

    if (imagePaths && imagePaths.length > 0) {
      const imagePath = imagePaths[0];
      console.log(`${rowLabel}: uploading image for '${perkataan}' -> ${path.basename(imagePath)}`);
      if (!dryRun) {
        try {
          uploadId = await uploadFile(strapiUrl, token, imagePath, renderToken);
          payload.Image = [uploadId];
        } catch (err) {
          const status = err.response?.status;
          const data = err.response?.data || err.message;
          failures.push({ row: index + 1, error: `Image upload failed: ${status || 'unknown'} ${JSON.stringify(data)}` });
          console.error(`${rowLabel}: image upload failed for ${imagePath}:`, status, data);
          continue;
        }
      }
    } else {
      console.warn(`${rowLabel}: no image found for '${perkataan}'. Entry will be created without Image.`);
    }

    if (dryRun) {
      console.log(`${rowLabel}: dry-run payload`, JSON.stringify(payload, null, 2));
      success += 1;
      continue;
    }

    try {
      const result = await createVocabEntry(strapiUrl, token, payload, renderToken);
      console.log(`${rowLabel}: created BIM entry id=${result.data.id} for '${perkataan}'.`);
      try {
        await getBimEntry(strapiUrl, token, result.data.id, renderToken);
      } catch (fetchErr) {
        console.error(`${rowLabel}: failed to fetch created BIM entry:`, fetchErr.response?.data || fetchErr.message);
      }
      success += 1;
    } catch (err) {
      failures.push({ row: index + 1, error: err.message });
      console.error(`${rowLabel}: failed to create BIM entry for '${perkataan}':`, err.response?.data || err.message);
    }
  }

  console.log('---');
  console.log(`Completed. Success: ${success}, Skipped: ${skipped}, Failures: ${failures.length}`);
  if (failures.length > 0) {
    console.log('Failures:', JSON.stringify(failures, null, 2));
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
