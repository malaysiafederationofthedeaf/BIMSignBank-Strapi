# BIM SignBank Bulk Upload

Simple helper scripts for uploading BIM vocabulary entries and matching images to Strapi.

## Setup

Install dependencies from this folder:

```bash
npm install
```

## Files

- `bulk-upload-vocabs.js`: uploads CSV rows and images to the `BIM` collection.
- `seed-category-groups.js`: creates missing category groups from CSV values.
- `vocabs.csv`: vocabulary data.
- `images/`: image files named after `Perkataan`.

## CSV format

Required columns:
- `Perkataan`
- `Word`
- `Video`

Optional columns:
- `Image_Status`
- `Video_Status`
- `Example_Sentence`
- `Contoh_Ayat`
- `category_group` or `KumpulanKategori`

## Run

Use a single line in PowerShell or bash. Avoid inserting newlines inside either token value.

The script requires both the Strapi API token and the render token together for remote deployment. Copy and paste both token values on the same command line, using `--token=` for the Strapi API token and `--render-token=` for the render token.

```powershell
node bulk-upload-vocabs.js --url=https://your-strapi-url.com --token=your_api_token --render-token=your_render_token
```

This means one command, with both flags present, for example:

```powershell
node bulk-upload-vocabs.js --url=https://bimsignbank-strapi.onrender.com --token=abcdef123456... --render-token=1234abcd...
```

If you need multiline PowerShell syntax, use the backtick (`), not a backslash:

```powershell
node bulk-upload-vocabs.js `
  --url=https://your-strapi-url.com `
  --token=your_api_token `
  --render-token=your_render_token
```

In bash, backslash continuation still works:

```bash
node bulk-upload-vocabs.js \
  --url=https://your-strapi-url.com \
  --token=your_api_token \
  --render-token=your_render_token
```

The script uses `vocabs.csv` and `images/` from the current folder by default. You only need to pass `--url` and `--token`.

If `--url` is omitted, the script defaults to `https://localhost:1337`.

## Dry run

Preview payloads without sending data:

```bash
node bulk-upload-vocabs.js --token=your_api_token --dry-run=true
```

## Troubleshooting

- `CSV file not found`: confirm `vocabs.csv` exists.
- `Images folder not found`: confirm `images/` exists.
- `400` errors: confirm the URL and API token are valid.
- `403` errors: confirm the token has create permissions for the `BIM` collection and upload permissions for media.

## Notes

- The script uploads only the first matching image for each `Perkataan`.
- Extra CSV columns are ignored.
