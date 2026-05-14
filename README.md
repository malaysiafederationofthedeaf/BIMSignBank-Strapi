# BIMSignBank Strapi Project

## Project Overview

This project is a Strapi-based Content Management System (CMS) designed for BIMSignBank, a platform for managing Building Information Modeling (BIM) vocabularies and related signs. It provides APIs for handling BIM content types, category groups, and supports bulk uploading of vocabularies with associated images. The system is built to facilitate the organization and retrieval of BIM-related terms, potentially including sign language representations or visual aids for accessibility in construction and engineering contexts.

## Local Development Setup

For detailed instructions on setting up the project locally, including prerequisites, environment configuration, and running the development server, see [projectSetup.md](projectSetup.md).

## Hosting on Render

This project is hosted on Render, a cloud platform for deploying web applications. It is deployed under the MFD account. To access the hosted instance:

1. The application is deployed as a web service on Render.
2. Access the admin panel at the Render URL
3. For API endpoints, use the base URL.
4. Deployment is automated via GitHub integration; pushes to the main branch trigger redeployments.
5. Environment variables for database connections, API keys, and other configurations are set in the Render dashboard.

Note: Ensure you have the necessary credentials to access the Render account for management or updates.

## Bulk Upload Script

The bulk upload functionality is located in the `bulk-upload-script/` folder. This script allows for importing BIM vocabularies in bulk from a CSV file, along with associated images.

For detailed instructions on how to use the bulk upload feature, refer to the README.md file inside the `bulk-upload-script/` directory. It provides step-by-step guidance on preparing the CSV file (e.g., `vocabs.csv`), organizing images in the `images/` subfolder, and running the upload process to populate the Strapi database with BIM content.
