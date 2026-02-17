import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "pg";
import dotenv from "dotenv";
import { HfInference } from "@huggingface/inference";

dotenv.config();

const { Pool } = pkg;
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
});

const hf = new HfInference(process.env.HF_API_KEY);

const server = new Server(
    { name: "pgvector-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

const tools = [
    {
        name: "search_items",
        description: "Search items using vector similarity",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query" },
            },
            required: ["query"],
        },
    },
    {
        name: "add_item",
        description: "Store new item(s) with auto-embedding",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: ["string", "array"], description: "Text or array of texts to store" },
            },
            required: ["name"],
        },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === "search_items") {
            const { query } = args;
            const embeddingResponse = await hf.featureExtraction({ model: "sentence-transformers/all-MiniLM-L6-v2", inputs: query });
            const vector = Array.isArray(embeddingResponse[0]) ? embeddingResponse[0] : embeddingResponse;
            const result = await pool.query(
                "SELECT id, name FROM items ORDER BY embedding <-> $1 LIMIT 5",
                [`[${vector.join(",")}]`]
            );
            return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
        }

        if (name === "add_item") {
            const names = Array.isArray(args.name) ? args.name : [args.name];
            const embeddingResponse = await hf.featureExtraction({ model: "sentence-transformers/all-MiniLM-L6-v2", inputs: names });
            const embeddings = Array.isArray(embeddingResponse[0]) ? embeddingResponse : [embeddingResponse];

            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const inserted = [];
                for (let i = 0; i < names.length; i++) {
                    const result = await client.query(
                        "INSERT INTO items (name, embedding) VALUES ($1, $2) RETURNING id, name",
                        [names[i], `[${embeddings[i].join(",")}]`]
                    );
                    inserted.push(result.rows[0]);
                }
                await client.query("COMMIT");
                return { content: [{ type: "text", text: `Stored ${inserted.length} items.` }] };
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
        }
    } catch (err) {
        return { content: [{ type: "text", text: err.message }], isError: true };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP Server Running");
