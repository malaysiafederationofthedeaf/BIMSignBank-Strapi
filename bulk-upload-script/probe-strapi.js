const axios = require('axios');

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

const args = parseArgs();
const token = args.token || process.env.STRAPI_TOKEN;

if (!token) {
  console.error('ERROR: A Strapi API token is required via --token or STRAPI_TOKEN.');
  process.exit(1);
}

const urls = [
  'https://bimsignbank-strapi.onrender.com/api/bims/6092?populate=category_group',
  'https://bimsignbank-strapi.onrender.com/api/bims?populate=category_group&pagination[pageSize]=5',
];

(async () => {
  for (const url of urls) {
    try {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      console.log('OK', url, res.status);
    } catch (err) {
      console.log('ERR', url, err.response?.status, err.response?.data || err.message);
    }
  }
})();