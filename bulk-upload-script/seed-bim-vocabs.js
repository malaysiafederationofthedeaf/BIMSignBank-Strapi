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
    const value = rest.join('=');
    if (key.startsWith('--')) {
      result[key.slice(2)] = value || 'true';
    }
  });
  return result;
}

function normalizeHeader(key) {
  return key ? key.toString().trim() : '';
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  let url = rawUrl.toString().trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
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
  if (!fs.existsSync(imagesPath)) {
    return new Map();
  }
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

async function uploadFile(strapiUrl, token, filePath) {
  const form = new FormData();
  form.append('files', fs.createReadStream(filePath));
  const url = new URL('/api/upload', strapiUrl).href;
  try {
    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      httpsAgent,
    });
    if (res.data && res.data.length > 0) {
      return res.data[0].id;
    }
  } catch (err) {
    console.error(`  Error uploading ${path.basename(filePath)}:`, err.message);
    if (err.response?.status === 400) {
      console.error('    Response:', JSON.stringify(err.response.data, null, 2));
    }
  }
  return null;
}

async function fetchCategoryGroups(strapiUrl, token) {
  try {
    const url = new URL('/api/category-groups?pagination[pageSize]=1000', strapiUrl).href;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent,
    });

    const categoryMap = new Map();
    res.data.data.forEach((group) => {
      const categoryName = group.KumpulanKategori?.trim();
      if (categoryName) {
        categoryMap.set(categoryName, group.id);
      }
    });

    console.log(`Loaded ${categoryMap.size} category groups\n`);
    return categoryMap;
  } catch (err) {
    console.error('Error fetching category groups:', err.message);
    if (err.response?.status === 400) {
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    return new Map();
  }
}

async function createVocabEntry(strapiUrl, token, row, imageMap, categoryMap) {
  try {
    const perkataan = row.Perkataan?.trim();
    if (!perkataan) {
      return false;
    }

    const data = {
      Perkataan: perkataan,
      Word: row.Word?.trim() || '',
      Video: row.Video?.trim() || '',
      Image_Status: row.Image_Status?.trim() || '',
      Video_Status: row.Video_Status?.trim() || '',
      Example_Sentence: row.Example_Sentence?.trim() || '',
      Contoh_Ayat: row.Contoh_Ayat?.trim() || '',
    };

    // Handle image upload
    const perkataaLower = perkataan.toLowerCase();
    if (imageMap.has(perkataaLower)) {
      const imagePaths = imageMap.get(perkataaLower);
      if (imagePaths.length > 0) {
        const imageId = await uploadFile(strapiUrl, token, imagePaths[0]);
        if (imageId) {
          data.Image = imageId;
        }
      }
    }

    // Handle category_group relation
    const categoryGroupName = row.category_group?.trim();
    if (categoryGroupName && categoryMap.has(categoryGroupName)) {
      const categoryGroupId = categoryMap.get(categoryGroupName);
      data.category_group = categoryGroupId;
    }

    // Create the BIM entry
    const url = new URL('/api/bims', strapiUrl).href;
    const res = await axios.post(url, { data }, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent,
    });

    return res.data.data.id;
  } catch (err) {
    console.error(`  Error creating entry for ${row.Perkataan}:`, err.message);
    if (err.response?.status === 400) {
      console.error('    Response:', JSON.stringify(err.response.data, null, 2));
    }
    return null;
  }
}

(async () => {
  try {
    const args = parseArgs();
    const token = args.token;
    const strapiUrl = normalizeUrl(args.url || 'https://bimsignbank-strapi.onrender.com');

    if (!token) {
      console.error('Error: --token argument is required');
      console.log('\nUsage: node seed-bim-vocabs.js --url=https://yourstrapi.com --token=your_api_token');
      process.exit(1);
    }

    const csvFile = path.join(__dirname, 'vocabs.csv');
    const imagesPath = path.join(__dirname, 'images');

    if (!fs.existsSync(csvFile)) {
      console.error(`CSV file not found: ${csvFile}`);
      process.exit(1);
    }

    console.log(`Strapi URL: ${strapiUrl}`);
    console.log(`Loading CSV from: ${csvFile}`);
    console.log(`Loading images from: ${imagesPath}\n`);

    const rows = loadRows(csvFile);
    const imageMap = buildImageMap(imagesPath);
    const categoryMap = await fetchCategoryGroups(strapiUrl, token);

    if (rows.length === 0) {
      console.warn('No rows found in CSV');
      process.exit(0);
    }

    console.log(`Processing ${rows.length} rows...\n`);

    let successCount = 0;
    let failureCount = 0;

    for (const row of rows) {
      const entryId = await createVocabEntry(strapiUrl, token, row, imageMap, categoryMap);
      if (entryId) {
        successCount += 1;
        console.log(`✓ ${row.Perkataan} (ID: ${entryId})`);
      } else {
        failureCount += 1;
        console.log(`✗ ${row.Perkataan}`);
      }
    }

    console.log(`\n✓ Success: ${successCount}`);
    console.log(`✗ Failures: ${failureCount}`);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
