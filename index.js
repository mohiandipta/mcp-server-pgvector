import express from "express";
import bodyParser from "body-parser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "pg";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

(async () => {
    try {
        await pool.query("SELECT 1");
        console.log("✅ DB successfully connected");
    } catch (err) {
        console.error("❌ Database error:", err);
    }
})();

// OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// MCP server
const server = new McpServer({
    name: "pgvector-mcp",
    version: "1.0.0",
});

// Register Pool tool
server.tool(
    "search_items",
    {
        query_embedding: {
            types: "array",
            items: { type: "number" },
            minItem: 384,
            maxItem: 384,
        },
    },
    async ({ query_embedding }) => {
        const result = await pool.query(
            `SELECT id, name 
       FROM items
       ORDER BY embedding <-> $1
       LIMIT 5`,
            [query_embedding]
        );

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(
                        result.rows.map((row) => ({
                            id: row.id,
                            name: row.name,
                        }))
                    ),
                },
            ],
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Express API
const app = express();
app.use(bodyParser.json());

// New GET route for ?query=
app.get("/search", async (req, res) => {
    try {
        const { query, embedding } = req.query;

        let queryEmbedding;

        if (query) {
            // Generate embedding from text query
            const response = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: query,
            });

            queryEmbedding = response.data[0].embedding; // This is a 384-d vector
        } else if (embedding) {
            // Manual embedding via ?embedding=0.01,0.02,...,0.384
            queryEmbedding = embedding.split(",").map(Number);
            if (queryEmbedding.length !== 384)
                return res.status(400).json({ error: "Invalid embedding vector length" });
        } else {
            return res.status(400).json({ error: "Provide either query or embedding" });
        }

        // Call MCP tool
        const response = await server.runTool("search_items", { query_embedding: queryEmbedding });

        res.json(response);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

app.listen(3010, () => {
    console.log("🚀 API server running at http://localhost:3010");
});
