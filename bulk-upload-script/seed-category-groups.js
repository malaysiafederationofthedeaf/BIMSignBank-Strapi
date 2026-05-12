const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

function loadRows(csvFile) {
  const csvText = fs.readFileSync(csvFile, 'utf8');
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map((key) => (key ? key.toString().trim() : ''));
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] !== undefined ? values[idx] : '';
    });
    return row;
  });
}

async function fetchExistingCategoryGroups(strapiUrl, token) {
  const url = new URL('/api/category-groups?pagination[pageSize]=1000', strapiUrl).href;
  console.log('Fetching existing category groups from:', url);
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const groups = response.data.data || [];
    const existing = new Set();
    groups.forEach((group) => {
      const name = group.attributes?.KumpulanKategori || group.KumpulanKategori;
      if (name) {
        existing.add(name.trim());
      }
    });
    console.log(`Found ${existing.size} existing category groups.`);
    return existing;
  } catch (err) {
    console.error('Error fetching existing category groups:', err.response?.data || err.message);
    return new Set();
  }
}

async function createCategoryGroup(strapiUrl, token, name) {
  const url = new URL('/api/category-groups', strapiUrl).href;
  console.log(`Creating category group: "${name}"`);
  try {
    const response = await axios.post(
      url,
      {
        data: {
          KumpulanKategori: name,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✓ Created category group "${name}" with ID: ${response.data.data.id}`);
    return response.data.data.id;
  } catch (err) {
    console.error(`✗ Failed to create category group "${name}":`, err.response?.data || err.message);
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const strapiUrl = normalizeUrl(args.url || process.env.STRAPI_URL || 'https://localhost:1337');
  const token = args.token || process.env.STRAPI_TOKEN;
  const csvFile = args.csv || args.excel || process.env.CSV_FILE || process.env.EXCEL_FILE || 'vocabs.csv';

  if (!token) {
    console.error('ERROR: A Strapi API token is required via --token or STRAPI_TOKEN.');
    process.exit(1);
  }

  const absCsv = path.resolve(csvFile);

  if (!fs.existsSync(absCsv)) {
    console.error(`ERROR: CSV file not found: ${absCsv}`);
    process.exit(1);
  }

  console.log('Using Strapi URL:', strapiUrl);
  console.log('Reading CSV file:', absCsv);

  const rows = loadRows(absCsv);
  const existingGroups = await fetchExistingCategoryGroups(strapiUrl, token);

  const csvGroups = new Set();
  rows.forEach((row) => {
    const rawCategory =
      row.category_group ??
      row.categoryGroup ??
      row.KUMPULANKATEGORI ??
      row.KumpulanKategori ??
      row['Kumpulan Kategori'];
    if (rawCategory && rawCategory.toString().trim()) {
      csvGroups.add(rawCategory.toString().trim());
    }
  });

  console.log(`Found ${csvGroups.size} unique category groups in CSV.`);
  let created = 0;

  for (const groupName of csvGroups) {
    if (!existingGroups.has(groupName)) {
      const newId = await createCategoryGroup(strapiUrl, token, groupName);
      if (newId) {
        created += 1;
      }
    }
  }

  console.log('---');
  console.log(`Completed. Created ${created} new category groups.`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});