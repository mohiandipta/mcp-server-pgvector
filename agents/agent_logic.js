import { ChatGroq } from "@langchain/groq";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DynamicStructuredTool } from "langchain/tools";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createAgent() {
    // 1️⃣ Create MCP client
    const client = new Client(
        {
            name: "langchain-agent",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // 2️⃣ Create transport - points to the mcp-server/index.js
    const serverPath = path.join(__dirname, "..", "mcp-server", "index.js");
    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
    });

    // 3️⃣ Connect properly
    await client.connect(transport);

    // 4️⃣ Load MCP tools
    const toolsResponse = await client.listTools();
    const mcpTools = toolsResponse.tools || [];

    // 5️⃣ Wrap MCP tools for LangChain
    const tools = mcpTools.map((tool) => {
        let zodSchema;
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
            const properties = tool.inputSchema.properties || {};
            const required = tool.inputSchema.required || [];

            const schemaObj = {};
            for (const [key, value] of Object.entries(properties)) {
                if (value.type === 'string' || (Array.isArray(value.type) && value.type.includes('string'))) {
                    schemaObj[key] = required.includes(key) ? z.string() : z.string().optional();
                } else if (value.type === 'number') {
                    schemaObj[key] = required.includes(key) ? z.number() : z.number().optional();
                } else if (value.type === 'boolean') {
                    schemaObj[key] = required.includes(key) ? z.boolean() : z.boolean().optional();
                } else if (value.type === 'array' || (Array.isArray(value.type) && value.type.includes('array'))) {
                    schemaObj[key] = required.includes(key) ? z.array(z.any()) : z.array(z.any()).optional();
                } else {
                    schemaObj[key] = required.includes(key) ? z.any() : z.any().optional();
                }
            }
            zodSchema = z.object(schemaObj);
        } else {
            zodSchema = z.object({});
        }

        return new DynamicStructuredTool({
            name: tool.name,
            description: tool.description ?? "",
            schema: zodSchema,
            func: async (args) => {
                const result = await client.callTool({
                    name: tool.name,
                    arguments: args,
                });

                const text = result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join("\n");

                if (result.isError) {
                    throw new Error(text || "Unknown tool error");
                }

                return text;
            },
        });
    });

    // 6️⃣ Setup LLM (Groq)
    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.1-8b-instant",
        temperature: 0,
    });

    // 7️⃣ Create prompt template
    const prompt = ChatPromptTemplate.fromMessages([
        ["system", `You are a precise search assistant.
- Use 'search_items' to find information.
- ONLY use 'add_item' if the user explicitly asks you to "add", "save", "store", or "create" a new item.
- If 'search_items' returns results, summarize them clearly.
- If 'search_items' returns an empty list [], tell the user that no matching items were found. Do NOT try to add the missing items yourself unless asked.
- Answer the user's question directly based on the tool outputs.`],
        ["human", "{input}"],
        new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // 8️⃣ Create agent
    const agent = await createToolCallingAgent({
        llm,
        tools,
        prompt,
    });

    // 9️⃣ Create executor
    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        verbose: false,
        maxIterations: 10,
    });

    return { agentExecutor, client };
}
