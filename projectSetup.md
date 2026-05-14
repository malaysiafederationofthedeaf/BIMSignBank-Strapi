# Project Setup Guide

## Prerequisites
- Node.js 18-22.x.x
- npm >= 6.0.0
- Git

## Local Development Setup

### 1. Clone the Repository
```bash
git clone <repository-url>
cd BIMSignBank-Strapi
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory:

```env
# Database Configuration (Local SQLite)
DATABASE_CLIENT=sqlite
DATABASE_FILENAME=.tmp/data.db

# Server Configuration
HOST=0.0.0.0
PORT=1337
APP_KEYS=your-app-key-1,your-app-key-2,your-app-key-3,your-app-key-4
INTERNAL_TOKEN=your-internal-token

# Optional: For production-like setup with PostgreSQL
# DATABASE_CLIENT=postgres
# DATABASE_URL=postgresql://username:password@localhost:5432/database_name
# DATABASE_SSL=false

# AWS S3/R2 Configuration (if using file uploads)
# AWS_ACCESS_KEY_ID=your-access-key
# AWS_ACCESS_SECRET=your-secret-key
# AWS_REGION=your-region
# AWS_BUCKET=your-bucket-name
```

### 4. Database Setup
For local development, the project uses SQLite by default. The database file will be created automatically at `.tmp/data.db` when you first run the application.

If you prefer to use PostgreSQL locally:
1. Install PostgreSQL
2. Create a database
3. Update the `.env` file with PostgreSQL connection details

### 5. Run the Development Server
```bash
npm run develop
```

The server will start at `http://localhost:1337`

### 6. Access the Admin Panel
1. Open your browser and go to `http://localhost:1337/admin`
2. Create your first admin user
3. Configure content types and plugins as needed

### 7. API Endpoints
The API will be available at `http://localhost:1337/api`

## Seeding Data

### Category Groups
To seed category groups:
```bash
cd bulk-upload-script
npm install
node seed-category-groups.js --url=http://localhost:1337 --token=your-api-token
```

### BIM Vocabularies
To upload BIM vocabularies:
```bash
node bulk-upload-vocabs.js --url=http://localhost:1337 --token=your-api-token
```

## Production Deployment

This project is configured for deployment on Render. See the main README.md for deployment details.

## Troubleshooting

- If you encounter database connection issues, ensure your `.env` file is correctly configured
- For file upload issues, verify AWS S3/R2 credentials
- Check the Strapi logs in the terminal for detailed error messages