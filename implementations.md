# Project Implementation Documentation

## Database Configuration

The project uses PostgreSQL with Supabase as the database provider. SSL configuration was adjusted to ensure proper connection:

```env
DATABASE_CLIENT=postgres
DATABASE_SSL=false
DATABASE_URL=postgresql://postgres.iigidhentirdptmbxhkg:SupaBaseStraoi@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres


## Content Types Implementation
### BIM Collection
The BIM collection was updated to match the XLSX file structure with the following fields:

```json
{
  "kind": "collectionType",
  "collectionName": "bims",
  "info": {
    "singularName": "bim",
    "pluralName": "bims",
    "displayName": "BIM"
  },
  "options": {
    "draftAndPublish": true
  },
  "attributes": {
    "Perkataan": {
      "type": "string"
    },
    "Word": {
      "type": "string"
    },
    "category_group": {
      "type": "relation",
      "relation": "manyToOne",
      "target": "api::category-group.category-group",
      "inversedBy": "bims"
    },
    "Kumpulan": {
      "type": "string"
    },
    "Group": {
      "type": "string"
    },
    "Kategori": {
      "type": "string"
    },
    "Category": {
      "type": "string"
    },
    "Tag": {
      "type": "string"
    },
    "Order": {
      "type": "integer"
    },
    "New": {
      "type": "string"
    },
    "SOTD": {
      "type": "string"
    },
    "Video": {
      "type": "string"
    },
    "Image_Status": {
      "type": "string"
    },
    "Video_Status": {
      "type": "string"
    },
    "Release": {
      "type": "string"
    },
    "Remark": {
      "type": "text"
    }
  }
}
 ```
```

### Category Group Collection
The Category Group collection was updated to match the XLSX file structure with the following fields:

```json
{
  "kind": "collectionType",
  "collectionName": "category_groups",
  "info": {
    "singularName": "category-group",
    "pluralName": "category-groups",
    "displayName": "Category Group"
  },
  "options": {
    "draftAndPublish": true
  },
  "attributes": {
    "KumpulanKategori": {
      "type": "string"
    },
    "GroupCategory": {
      "type": "string"
    },
    "Remark": {
      "type": "text"
    },
    "bims": {
      "type": "relation",
      "relation": "oneToMany",
      "target": "api::bim.bim",
      "mappedBy": "category_group"
    }
  }
}
 ```

## Relationships Implementation
A relationship was established between the BIM and Category Group collections:

1. BIM to Category Group : Many-to-One relationship
   
   - Each BIM entry can be associated with one Category Group
   - The relationship field is named category_group in the BIM collection
2. Category Group to BIM : One-to-Many relationship
   
   - Each Category Group can have multiple BIM entries
   - The relationship field is named bims in the Category Group collection
## UI Implementation
In the Strapi admin interface:

1. When creating or editing a BIM entry, a dropdown is available to select the associated Category Group
2. The dropdown displays the available Category Groups from the Category Group collection
3. When viewing a Category Group, related BIM entries can be seen in the interface
## Data Import Process
To import data from the XLSX file:

1. Create Category Group entries first
2. Then create BIM entries, associating them with the appropriate Category Group using the dropdown
## API Endpoints
The following API endpoints are available:

1. BIM Collection :
   
   - GET /api/bims : List all BIM entries
   - GET /api/bims/:id : Get a specific BIM entry
   - POST /api/bims : Create a new BIM entry
   - PUT /api/bims/:id : Update a BIM entry
   - DELETE /api/bims/:id : Delete a BIM entry
2. Category Group Collection :
   
   - GET /api/category-groups : List all Category Group entries
   - GET /api/category-groups/:id : Get a specific Category Group entry
   - POST /api/category-groups : Create a new Category Group entry
   - PUT /api/category-groups/:id : Update a Category Group entry
   - DELETE /api/category-groups/:id : Delete a Category Group entry
## Querying Related Data
To query BIM entries with their related Category Group:

```plaintext
GET /api/bims?populate=category_group
 ```

To query Category Groups with their related BIM entries:

```plaintext
GET /api/category-groups?populate=bims
 ```
