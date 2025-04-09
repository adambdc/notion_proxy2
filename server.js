// server.js
// Import necessary modules
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables from .env file (especially for local development)
dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 3000; // Use port from environment or default to 3000
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const PROXY_API_KEY = process.env.PROXY_API_KEY; // Secret key for authenticating requests to this proxy
const NOTION_API_VERSION = '2022-06-28';
const NOTION_BASE_URL = 'https://api.notion.com/v1';

// --- Input Validation & Pre-checks ---
if (!NOTION_API_KEY) {
  console.error("FATAL ERROR: NOTION_API_KEY environment variable is not set.");
  process.exit(1);
}
if (!PROXY_API_KEY) {
  // If running in production (or explicitly required), demand the proxy key
  // For local dev, you might allow it to be missing, but it's safer to require it.
  console.warn("WARNING: PROXY_API_KEY environment variable is not set. Proxy authentication is disabled.");
  // Or exit if you want to enforce it always:
  // console.error("FATAL ERROR: PROXY_API_KEY environment variable is not set.");
  // process.exit(1);
}


// --- Initialize Express App ---
const app = express();

// --- Middleware ---
// Parse JSON request bodies
app.use(express.json());
// Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// --- Axios Instance for Notion API ---
const notionApi = axios.create({
  baseURL: NOTION_BASE_URL,
  headers: {
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_API_VERSION,
  },
  timeout: 10000, // 10 seconds
});


// --- Authentication Middleware ---
// Middleware to check for the proxy API key
const authenticateProxyRequest = (req, res, next) => {
  // Skip authentication if PROXY_API_KEY is not configured (useful for local dev sometimes)
  if (!PROXY_API_KEY) {
      console.warn("Skipping proxy authentication because PROXY_API_KEY is not set.");
      return next();
  }

  const providedKey = req.headers['x-proxy-api-key']; // Case-insensitive header check might be better

  if (!providedKey) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Missing X-Proxy-API-Key header.' });
  }

  if (providedKey !== PROXY_API_KEY) {
    return res.status(403).json({ error: 'Forbidden', details: 'Invalid X-Proxy-API-Key.' });
  }

  // Key is valid, proceed to the next middleware or route handler
  next();
};

// --- Public Routes ---

// Health check endpoint (does not require authentication)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});


// --- Apply Authentication Middleware ---
// All routes defined AFTER this middleware will require the X-Proxy-API-Key header
app.use(authenticateProxyRequest);


// --- Protected Routes ---

/**
 * @route GET /blocks/:block_id/children
 * @description Fetches the children of a specific Notion block.
 * @param {string} block_id - The ID of the Notion block.
 * @header X-Proxy-API-Key - The secret key to authenticate with this proxy.
 * @returns {object} Notion API response for block children.
 */
app.get('/blocks/:block_id/children', async (req, res, next) => {
  const { block_id } = req.params;

  if (!block_id) {
    return res.status(400).json({ error: 'Bad Request', details: 'Missing block_id parameter.' });
  }

  try {
    console.log(`Fetching children for block: ${block_id}`);
    // Make the request to the Notion API using the pre-configured Axios instance
    const response = await notionApi.get(`/blocks/${block_id}/children`);
    console.log(`Successfully fetched children for block: ${block_id}`);
    // Forward the response data from Notion back to the client
    res.status(response.status).json(response.data);
  } catch (error) {
    // Log the error and pass it to the global error handler
    console.error(`Error fetching children for block ${block_id}:`, error.message);
    next(error); // Pass error to the global error handler
  }
});

/**
 * @route POST /query-database/:database_id
 * @description Queries a specific Notion database, forwarding the raw request body.
 * @param {string} database_id - The ID of the Notion database.
 * @header X-Proxy-API-Key - The secret key to authenticate with this proxy.
 * @body {object} The raw Notion database query object.
 * @returns {object} Notion API response for the database query.
 */
app.post('/query-database/:database_id', async (req, res, next) => {
  const { database_id } = req.params;
  const queryBody = req.body; // The raw request body from the client

  if (!database_id) {
    return res.status(400).json({ error: 'Bad Request', details: 'Missing database_id parameter.' });
  }

  if (!queryBody || Object.keys(queryBody).length === 0) {
      return res.status(400).json({ error: 'Bad Request', details: 'Missing request body for database query.' });
  }

  try {
    console.log(`Querying database: ${database_id}`);
    // Make the POST request to the Notion API, passing the database_id in the URL
    // and the client's request body as the data payload.
    const response = await notionApi.post(`/databases/${database_id}/query`, queryBody);
    console.log(`Successfully queried database: ${database_id}`);
    // Forward the Notion API response back to the client
    res.status(response.status).json(response.data);
  } catch (error) {
    // Log the error and pass it to the global error handler
    console.error(`Error querying database ${database_id}:`, error.message);
    next(error); // Pass error to the global error handler
  }
});

/**
 * @route POST /insert-record/:database_id
 * @description Inserts a new page into a specified Notion database based on a simplified payload.
 * @param {string} database_id - The ID of the Notion database to insert into.
 * @header X-Proxy-API-Key - The secret key to authenticate with this proxy.
 * @body {object} Simplified payload: { Term: string, Definition: string, Category: string, Synonyms: string[] }
 * @returns {object} Notion API response for the created page.
 */
app.post('/insert-record/:database_id', async (req, res, next) => {
  const { database_id } = req.params;
  const { Term, Definition, Category, Synonyms } = req.body; // Destructure the simplified payload

  // --- Basic Input Validation ---
  if (!database_id) {
    return res.status(400).json({ error: 'Bad Request', details: 'Missing database_id parameter.' });
  }
  if (!Term || !Definition || !Category) { // Synonyms might be optional
    return res.status(400).json({ error: 'Bad Request', details: 'Missing required fields in request body (Term, Definition, Category).' });
  }
  if (Synonyms && !Array.isArray(Synonyms)) {
      return res.status(400).json({ error: 'Bad Request', details: 'Synonyms field must be an array of strings.'});
  }

  // --- !!! IMPORTANT: Notion Property Mapping !!! ---
  // This section needs to be customized based on YOUR specific Notion database schema.
  // Replace the placeholder property names ('Your Term Property Name', etc.)
  // and ensure the property types match your database setup (title, rich_text, select, multi_select, etc.).

  const notionPageProperties = {
    // Example for 'Term' as a 'title' property (usually called 'Name' or 'Title' in Notion)
    'Your Term Property Name': { // <-- Replace with your actual Notion property name for Term
      type: 'title',
      title: [
        {
          type: 'text',
          text: {
            content: Term,
          },
        },
      ],
    },
    // Example for 'Definition' as a 'rich_text' property
    'Your Definition Property Name': { // <-- Replace with your actual Notion property name for Definition
      type: 'rich_text',
      rich_text: [
        {
          type: 'text',
          text: {
            content: Definition,
          },
        },
      ],
    },
    // Example for 'Category' as a 'select' property
    'Your Category Property Name': { // <-- Replace with your actual Notion property name for Category
      type: 'select',
      select: {
        name: Category, // Assumes Category is a string matching a select option
      },
    },
    // Example for 'Synonyms' as a 'multi_select' property
    'Your Synonyms Property Name': { // <-- Replace with your actual Notion property name for Synonyms
        type: 'multi_select',
        multi_select: (Synonyms || []).map(synonym => ({ name: synonym })), // Assumes Synonyms is an array of strings matching multi-select options
    },
    // Add other properties from your database schema as needed, potentially with default values
  };

  // Construct the payload for the Notion API's pages endpoint
  const notionPayload = {
    parent: { database_id: database_id },
    properties: notionPageProperties,
    // You can also add icon or cover here if needed
    // icon: { type: "emoji", emoji: "💡" },
  };
  // --- End of Customization Section ---


  try {
    console.log(`Inserting record into database: ${database_id}`);
    // Make the POST request to the Notion API's pages endpoint
    const response = await notionApi.post('/pages', notionPayload);
    console.log(`Successfully inserted record into database: ${database_id}`);
    // Forward the Notion API response back to the client
    res.status(response.status).json(response.data);
  } catch (error) {
    // Log the error and pass it to the global error handler
    console.error(`Error inserting record into database ${database_id}:`, error.message);
    // Log the payload that caused the error for easier debugging (optional, consider data privacy)
    // console.error("Failed payload:", JSON.stringify(notionPayload, null, 2));
    next(error); // Pass error to the global error handler
  }
});


// --- Global Error Handling Middleware ---
// (Keep the existing error handler from v1)
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err.stack || err.message || err);

  // Handle Axios errors specifically
  if (axios.isAxiosError(err)) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message || 'An error occurred during the API request.';
    const code = err.response?.data?.code; // Notion specific error code
    console.error(`Axios Error: Status ${status}, Code: ${code}, Message: ${message}`);
    // Avoid sending back potentially complex/internal Notion error structures directly if sensitive
    const responseMessage = code ? `${message} (Notion Code: ${code})` : message;
    return res.status(status).json({
        error: 'Notion API Error',
        details: responseMessage,
        status: status
    });
  }

  // Generic server error
  res.status(500).json({
      error: 'Internal Server Error',
      details: 'An unexpected error occurred.',
      status: 500
  });
});


// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Notion Proxy Server listening on port ${PORT}`);
  console.log(`Notion API Version: ${NOTION_API_VERSION}`);
  if (PROXY_API_KEY) {
      console.log("Proxy authentication enabled.");
  } else {
      console.warn("Proxy authentication disabled (PROXY_API_KEY not set).");
  }
});

// Export the app
export default app;

```json
// package.json
// (No changes needed from the previous version)
{
  "name": "notion-proxy-server",
  "version": "1.0.0",
  "description": "Proxy server for interacting with the Notion API",
  "main": "server.js",
  "type": "module", // Using ES module syntax (import/export)
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js" // Requires nodemon: npm install -D nodemon
  },
  "keywords": [
    "notion",
    "api",
    "proxy",
    "express",
    "chatgpt"
  ],
  "author": "", // Add your name/org
  "license": "ISC", // Choose a license
  "dependencies": {
    "axios": "^1.6.8",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.0" // Optional: for auto-restarting during development
  }
}
```yaml
# render.yaml
# Basic configuration for deploying the Node.js proxy on Render

services:
  - type: web # Specifies a web service
    name: notion-proxy # Choose a name for your service
    env: node # Specifies the runtime environment
    plan: free # Or your desired Render plan (e.g., starter)
    buildCommand: npm install # Command to install dependencies
    startCommand: npm start # Command to start the server (uses package.json script)
    envVars:
      - key: NODE_VERSION # Optional: Specify Node.js version if needed
        value: 20 # Example: Use Node.js 20.x.x
      - key: NODE_ENV
        value: production
      # --- Secrets (Set these in the Render Dashboard Environment) ---
      - key: NOTION_API_KEY
        sync: false # Indicates this is a secret managed in Render UI
      - key: PROXY_API_KEY
        sync: false # Indicates this is a secret managed in Render UI
      # - key: NOTION_TARGET_DATABASE_ID # Add this if you switch insert-record to use env var
      #   sync: false

# Optional: Health Check configuration
# Render automatically checks '/' but you can customize it
#    healthCheckPath: /health
