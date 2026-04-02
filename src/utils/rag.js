import pg from "pg";

const EMBEDDING_URL = process.env.RAG_EMBEDDINGS_URL || "http://10.3.0.241:8082/v1/embeddings";
const EMBEDDING_DIMS = 768; // nomic-embed-text-v1.5
const CHUNK_SIZE = 350;     // chars per chunk (must stay under 512 tokens for llama-server batch size)
const CHUNK_OVERLAP = 50;   // overlap between chunks

let _pool = null;

function getPool() {
    if (_pool) return _pool;
    if (!process.env.RAG_DATABASE_URL) return null;
    _pool = new pg.Pool({ connectionString: process.env.RAG_DATABASE_URL, max: 5 });
    return _pool;
}

/**
 * Initialize the research_chunks table (called once on startup).
 */
export async function initRagDB() {
    const pool = getPool();
    if (!pool) { console.error("[RAG] No RAG_DATABASE_URL configured, skipping"); return; }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS research_chunks (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                embedding vector(${EMBEDDING_DIMS}),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON research_chunks (session_id)`);
        console.error("[RAG] Database initialized");
    } catch (err) {
        console.error("[RAG] Init error:", err.message);
    }
}

/**
 * Embed text using the local llama-server embedding endpoint.
 * Retries up to 3 times with exponential backoff for transient failures.
 */
export async function embedText(text) {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const resp = await fetch(EMBEDDING_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: text })
        });
        if (resp.ok) {
            const data = await resp.json();
            return data.data?.[0]?.embedding;
        }
        if (attempt < maxRetries && resp.status >= 500) {
            const delay = 1000 * 2 ** attempt;
            console.error(`[RAG] Embedding request failed (${resp.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        throw new Error(`Embedding request failed: ${resp.status}`);
    }
}

/**
 * Split text into overlapping chunks by paragraph boundaries.
 */
function chunkText(text, maxLen = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const paragraphs = text.split(/\n{2,}|\. (?=[A-Z])/);
    const chunks = [];
    let current = "";

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        if (current.length + trimmed.length + 1 > maxLen && current.length > 0) {
            chunks.push(current.trim());
            // Keep overlap from the end of current chunk
            current = current.slice(-overlap) + " " + trimmed;
        } else {
            current += (current ? " " : "") + trimmed;
        }
    }
    if (current.trim()) chunks.push(current.trim());

    // If no paragraph splits worked, fall back to fixed-size chunking
    if (chunks.length === 0 && text.length > 0) {
        for (let i = 0; i < text.length; i += maxLen - overlap) {
            chunks.push(text.slice(i, i + maxLen));
        }
    }

    return chunks;
}

/**
 * Store an article's content as embedded chunks.
 * @param {string} sessionId - Root thread ID for the chain
 * @param {string} url - Source URL
 * @param {string} title - Page title
 * @param {string} text - Cleaned article text
 * @returns {number} Number of chunks stored
 */
export async function storeArticle(sessionId, url, title, text) {
    const pool = getPool();
    if (!pool) return 0;

    // Check if already stored (idempotent)
    const existing = await pool.query(
        "SELECT COUNT(*) as cnt FROM research_chunks WHERE session_id = $1 AND url = $2",
        [sessionId, url]
    );
    if (parseInt(existing.rows[0].cnt) > 0) {
        console.error(`[RAG] Article already stored: ${url} (session ${sessionId})`);
        return 0;
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) return 0;

    console.error(`[RAG] Storing ${chunks.length} chunks for ${url} (session ${sessionId})`);

    // Embed all chunks in parallel (batch of 10 to avoid overwhelming the server)
    const batchSize = 10;
    let stored = 0;
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddings = await Promise.all(batch.map(c => embedText(c).catch(e => { console.error(`[RAG] Chunk embedding failed: ${e.message}`); return null; })));

        for (let j = 0; j < batch.length; j++) {
            if (!embeddings[j]) continue;
            await pool.query(
                `INSERT INTO research_chunks (session_id, url, title, chunk_index, content, embedding)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [sessionId, url, title, i + j, batch[j], `[${embeddings[j].join(",")}]`]
            );
            stored++;
        }
    }

    console.error(`[RAG] Stored ${stored} chunks for ${url}`);
    return stored;
}

/**
 * Query relevant chunks from the vector DB using cosine similarity.
 * @param {string} sessionId - Root thread ID
 * @param {string} query - Natural language query
 * @param {number} topK - Number of chunks to return
 * @returns {Array<{content: string, url: string, title: string, score: number}>}
 */
export async function queryChunks(sessionId, query, topK = 8) {
    const pool = getPool();
    if (!pool) return [];

    try {
        const queryEmbedding = await embedText(query);
        if (!queryEmbedding) return [];

        const result = await pool.query(
            `SELECT content, url, title, 1 - (embedding <=> $1::vector) as score
             FROM research_chunks
             WHERE session_id = $2
             ORDER BY embedding <=> $1::vector
             LIMIT $3`,
            [`[${queryEmbedding.join(",")}]`, sessionId, topK]
        );

        return result.rows.map(r => ({
            content: r.content,
            url: r.url,
            title: r.title,
            score: parseFloat(r.score)
        }));
    } catch (err) {
        console.error("[RAG] Query error:", err.message);
        return [];
    }
}

/**
 * Clean up all research chunks for a session.
 */
export async function cleanupSession(sessionId) {
    const pool = getPool();
    if (!pool) return;
    try {
        const result = await pool.query("DELETE FROM research_chunks WHERE session_id = $1", [sessionId]);
        if (result.rowCount > 0) console.error(`[RAG] Cleaned up ${result.rowCount} chunks for session ${sessionId}`);
    } catch (err) {
        console.error("[RAG] Cleanup error:", err.message);
    }
}

/**
 * Check if a session has any stored research chunks.
 */
export async function hasResearch(sessionId) {
    const pool = getPool();
    if (!pool) return false;
    try {
        const result = await pool.query("SELECT EXISTS(SELECT 1 FROM research_chunks WHERE session_id = $1) as has", [sessionId]);
        return result.rows[0]?.has || false;
    } catch { return false; }
}
