import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import pkg from "pg";
import dotenv from "dotenv";
import { HfInference } from "@huggingface/inference";
import { z } from "zod";

dotenv.config();
const { Pool } = pkg;

// PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT), // ✅ FIX
});

// HuggingFace
const hf = new HfInference(process.env.HF_API_KEY);

// MCP Server
const server = new Server(
    {
        name: "pgvector-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Define tools
const tools = [
    {
        name: "search_items",
        description: "Search items by natural language query using vector similarity",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Natural language search query",
                },
            },
            required: ["query"],
        },
    },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools,
    };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "search_items") {
        try {
            const { query } = args;
            console.error("🔎 Searching for:", query);

            // Generate embedding internally
            const embeddingResponse = await hf.featureExtraction({
                model: "sentence-transformers/all-MiniLM-L6-v2",
                inputs: query,
            });

            const queryEmbedding = Array.isArray(embeddingResponse[0])
                ? embeddingResponse[0]
                : embeddingResponse;

            if (!Array.isArray(queryEmbedding)) {
                throw new Error("Embedding generation failed");
            }

            // Format as vector string for PostgreSQL: [1, 2, 3]
            const vectorString = `[${queryEmbedding.join(",")}]`;

            // Vector similarity search
            const result = await pool.query(
                `
                SELECT id, name
                FROM items
                ORDER BY embedding <-> $1
                LIMIT 5
                `,
                [vectorString]
            );

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.rows, null, 2),
                    },
                ],
            };
        } catch (err) {
            console.error("❌ Tool error:", err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Search failed: ${err.message}`,
                    },
                ],
                isError: true,
            };
        }
    }

    return {
        content: [
            {
                type: "text",
                text: `Unknown tool: ${name}`,
            },
        ],
        isError: true,
    };
});

// Connect via stdio
try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ MCP server running...");
} catch (err) {
    console.error("❌ Server failed to start:", err);
}
