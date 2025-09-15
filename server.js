// server.js
import express from "express";
import pool from "./lib/db.js"; // import your mysql2 pool
import salesRoutes from "./routes/sales.js"
import cors from "cors";
import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" })); // allow bigger payload
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(cors());

// use sales API under /api/sales
app.use("/api/sales", salesRoutes);
app.get("/", (req, res) => {
    res.send("Server is working ✅");
});


// Together API config
const together = createOpenAI({
    apiKey: process.env.TOGETHER_API_KEY,
    baseURL: "https://api.together.xyz/v1",
});

// server.js (updated portion)
app.post("/chat", async (req, res) => {
    let connection;
    try {
        const { messages } = req.body;
        if (!messages || !messages.length) {
            return res.json({ content: "Please type something to search properties.", isTyping: false });
        }

        // ✅ Only use the latest user message for extracting filters
        const latestMessage = messages[messages.length - 1].content?.toLowerCase() || "";

        let dbResponse = "";

        // ✅ Check for greetings/casual messages first
        const greetings = ['hi', 'hii', 'hello', 'hey', 'helo', 'good morning', 'good afternoon', 'good evening'];
        const isGreeting = greetings.some(greeting => latestMessage.trim() === greeting || latestMessage.trim().startsWith(greeting + ' '));

        if (isGreeting) {
            return res.json({
                content: "Hello! 👋 I'm your Property Assistant. I can help you search for properties by location, price, bedrooms, bathrooms, or other criteria.<br/><br/>Try searching like:<br/>• '3 bedroom properties in Mumbai'<br/>• '2 BHK under 50 lakh in Delhi'<br/>• 'Goa properties with 2 bathrooms'<br/>• '4 bedroom houses in Bangalore'",
                isTyping: true
            });
        }

        // -------------------------
        // Extract location from latest message
        // -------------------------
        let foundLocation = null;
        const words = latestMessage.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
            if ((words[i] === "in" || words[i] === "at" || words[i] === "from") && i + 1 < words.length) {
                let candidate = words[i + 1].replace(/[^a-zA-Z]/g, "");
                if (!["me", "you", "us", "we"].includes(candidate.toLowerCase())) {
                    foundLocation = candidate;
                    if (i + 2 < words.length && /^[A-Z]/i.test(words[i + 2])) {
                        foundLocation += " " + words[i + 2].replace(/[^a-zA-Z]/g, "");
                    }
                    break;
                }
            }
        }

        // ✅ Extract property status
        let propertyStatus = null;
        const statusKeywords = {
            rent: ["rent", "rental", "for rent"],
            sold: ["sold", "booked"],
            open: ["open", "available"],
            closed: ["closed", "not available"],
            ready: ["ready to move", "ready", "immediate possession"]
        };

        for (const [status, keywords] of Object.entries(statusKeywords)) {
            if (keywords.some(k => latestMessage.includes(k))) {
                propertyStatus = status === "ready" ? "ready to move" : status;
                break;
            }
        }

        // ✅ Extract bedroom count
        let bedroomCount = null;
        const bedroomPatterns = [
            /(\d+)\s*(?:bedroom|bedrooms|bhk|br)/i,
            /(\d+)\s*(?:bed)/i,
            /(?:bedroom|bedrooms|bhk|br)\s*(\d+)/i
        ];
        for (const pattern of bedroomPatterns) {
            const match = latestMessage.match(pattern);
            if (match) {
                bedroomCount = parseInt(match[1]);
                break;
            }
        }

        // ✅ Extract bathroom count
        let bathroomCount = null;
        const bathroomPatterns = [
            /(\d+)\s*(?:bathroom|bathrooms|bath|ba)/i,
            /(?:bathroom|bathrooms|bath|ba)\s*(\d+)/i
        ];
        for (const pattern of bathroomPatterns) {
            const match = latestMessage.match(pattern);
            if (match) {
                bathroomCount = parseInt(match[1]);
                break;
            }
        }

        // ✅ Extract price ranges
        let maxPrice = null;
        let minPrice = null;
        const pricePatterns = [
            /under\s+([\d,]+)\s*(lakh|lakhs|lac|lacs|l)/i,
            /below\s+([\d,]+)\s*(lakh|lakhs|lac|lacs|l)/i,
            /([\d,]+)\s*(lakh|lakhs|lac|lacs|l)\s+under/i,
            /([\d,]+)\s*(lakh|lakhs|lac|lacs|l)\s+below/i,
            /under\s+([\d,]+)\s*(crore|crores|cr)/i,
            /below\s+([\d,]+)\s*(crore|crores|cr)/i,
            /above\s+([\d,]+)\s*(lakh|lakhs|lac|lacs|l)/i,
            /over\s+([\d,]+)\s*(lakh|lakhs|lac|lacs|l)/i,
            /([\d,]+)\s*(crore|crores|cr)\s+above/i,
        ];
        for (const pattern of pricePatterns) {
            const match = latestMessage.match(pattern);
            if (match) {
                const amount = parseInt(match[1].replace(/,/g, ""));
                const unit = match[2]?.toLowerCase();
                if (unit && unit.startsWith("cr")) {
                    if (pattern.source.includes("under") || pattern.source.includes("below")) maxPrice = amount * 10000000;
                    else minPrice = amount * 10000000;
                } else {
                    if (pattern.source.includes("under") || pattern.source.includes("below")) maxPrice = amount * 100000;
                    else minPrice = amount * 100000;
                }
                break;
            }
        }

        // -------------------------
        // ✅ Build query fresh for every request
        // -------------------------
        let query = "SELECT id, name, price, location, address,  landmarks, description, bedrooms, bathrooms, status";
        let imageColumn = null;
        const possibleImageColumns = ['banner_img', 'image', 'image_url', 'banner_image', 'property_image'];

        // Get a connection from the pool
        connection = await pool.getConnection();

        for (const colName of possibleImageColumns) {
            try {
                await connection.query(`SELECT ${colName} FROM properties LIMIT 1`);
                imageColumn = colName;
                query += `, ${colName}`;
                break;
            } catch (err) {
                console.log(`Column ${colName} not found, trying next...`);
            }
        }

        query += " FROM properties";
        let params = [];
        let whereConditions = [];

        if (foundLocation) {
            whereConditions.push("location LIKE ?");
            params.push(`%${foundLocation}%`);
        }
        if (propertyStatus) {
            whereConditions.push("LOWER(status) LIKE ?");
            params.push(`%${propertyStatus.toLowerCase()}%`);
        }
        if (maxPrice !== null) {
            whereConditions.push("price <= ?");
            params.push(maxPrice);
        }
        if (minPrice !== null) {
            whereConditions.push("price >= ?");
            params.push(minPrice);
        }
        if (bedroomCount !== null) {
            whereConditions.push("bedrooms = ?");
            params.push(bedroomCount);
        }
        if (bathroomCount !== null) {
            whereConditions.push("bathrooms = ?");
            params.push(bathroomCount);
        }

        if (whereConditions.length > 0) query += " WHERE " + whereConditions.join(" AND ");
        query += " ORDER BY price ASC LIMIT 15";

        console.log("🔍 Search Query:", query);
        console.log("📊 Parameters:", params);
        console.log("🏠 Bedrooms:", bedroomCount, "🚿 Bathrooms:", bathroomCount);

        const [rows] = await connection.query(query, params);

        // -------------------------
        // Format results
        // -------------------------
        if (rows.length > 0) {
            let searchCriteria = [];
            if (foundLocation) searchCriteria.push(`📍 Location: ${foundLocation}`);
            if (bedroomCount) searchCriteria.push(`🛏️ Bedrooms: ${bedroomCount}`);
            if (bathroomCount) searchCriteria.push(`🚿 Bathrooms: ${bathroomCount}`);
            if (maxPrice) searchCriteria.push(`💰 Max: ₹${(maxPrice / 100000).toFixed(0)} lakh`);
            if (minPrice) searchCriteria.push(`💰 Min: ₹${(minPrice / 100000).toFixed(0)} lakh`);

            let criteriaText = "";
            if (searchCriteria.length > 0) {
                criteriaText = `<div style="background:#e0f2fe;border:1px solid #0284c7;border-radius:8px;padding:12px;margin-bottom:15px;">
                    <div style="font-weight:bold;color:#0284c7;margin-bottom:6px;">🔍 Search Results for:</div>
                    <div style="color:#0369a1;font-size:14px;">${searchCriteria.join(' • ')}</div>
                    <div style="color:#0369a1;font-size:12px;margin-top:4px;">Found ${rows.length} matching properties</div>
                </div>`;
            }

            dbResponse = criteriaText + rows.map((p) => {
                let imageHtml;
                const imageUrl = imageColumn ? p[imageColumn] : null;
                if (imageUrl && imageUrl.trim() !== "") {
                    imageHtml = `<img src="${imageUrl}" alt="${p.name}" style="width:100%;height:120px;object-fit:cover;border-radius:8px;margin-bottom:8px;" onerror="this.style.display='none';this.nextElementSibling.style.display='block';">`;
                    imageHtml += `<div style="width:100%;height:120px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:8px;margin-bottom:8px;display:none;align-items:center;justify-content:center;font-size:32px;color:white;">🏠</div>`;
                } else {
                    imageHtml = `<div style="width:100%;height:120px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:8px;margin-bottom:8px;display:flex;align-items:center;justify-content:center;font-size:32px;color:white;">🏠</div>`;
                }

                let line1Details = [];
                let line2Details = [];

                if (p.bedrooms) line1Details.push(`🛏️ ${p.bedrooms}BR`);
                if (p.bathrooms) line1Details.push(`🚿 ${p.bathrooms}BA`);
                if (p.status) line1Details.push(`📋 ${p.status}`);

                line2Details.push(`📍 ${p.location}`);
                if (p.address && p.address !== p.location) line2Details.push(`🏠 ${p.address}`);
                if (p.landmarks) line2Details.push(`🗺️ ${p.landmarks}`);

                const line1Text = line1Details.length > 0 ? line1Details.join(' • ') : '';
                const line2Text = line2Details.join(' • ');

                return `<div style="margin-bottom:15px;border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                    ${imageHtml}
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <strong style="color:#2563eb;font-size:15px;"><a href="/properties/detail/${p.id}" target="_blank" style="color:#2563eb;text-decoration:none;">${p.name}</a></strong>
                        <span style="color:#059669;font-weight:bold;font-size:15px;">₹${Number(p.price).toLocaleString("en-IN")}</span>
                    </div>
                    ${line1Text ? `<div style="color:#6b7280;font-size:12px;margin-bottom:4px;">${line1Text}</div>` : ''}
                    <div style="color:#6b7280;font-size:12px;margin-bottom:6px;">${line2Text}</div>
                    <p style="color:#374151;font-size:12px;margin:0;line-height:1.3;">${p.description && p.description.length > 90 ? p.description.substring(0, 90) + "..." : p.description || 'No description available'}</p>
                    <button class="add-to-comparison" data-id="${p.id}" data-name="${p.name.replace(/"/g, '&quot;')}" style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:6px 12px;margin-top:8px;font-size:12px;cursor:pointer;color:#475569;">Add to Comparison</button>
                </div>`;
            }).join("");
        } else {
            let searchCriteria = [];
            if (foundLocation) searchCriteria.push(`in ${foundLocation}`);
            if (bedroomCount) searchCriteria.push(`${bedroomCount} bedrooms`);
            if (bathroomCount) searchCriteria.push(`${bathroomCount} bathrooms`);
            if (maxPrice) searchCriteria.push(`under ₹${(maxPrice / 100000).toFixed(0)} lakh`);
            if (minPrice) searchCriteria.push(`above ₹${(minPrice / 100000).toFixed(0)} lakh`);

            const criteria = searchCriteria.length > 0 ? ` matching: ${searchCriteria.join(', ')}` : '';

            dbResponse = `<div style="background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:15px;text-align:center;">
                <div style="color:#dc2626;font-size:16px;margin-bottom:8px;">🚫 No Properties Found</div>
                <div style="color:#991b1b;font-size:14px;margin-bottom:10px;">No properties found${criteria}</div>
                <div style="color:#7f1d1d;font-size:12px;">
                    💡 Try adjusting your search:<br/>
                    • Remove bedroom/bathroom requirements<br/>
                    • Increase price range<br/>
                    • Search in different locations<br/>
                    • Use broader search terms
                </div>
            </div>`;
        }

        return res.json({ content: dbResponse, isTyping: true });

    } catch (err) {
        console.error("❌ Backend error:", err);
        return res.json({ content: "Server error, please try again later.", isTyping: false });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Add this to your server.js file
app.get("/api/property/:id", async (req, res) => {
    let connection;
    try {
        const propertyId = req.params.id;
        connection = await pool.getConnection();

        const [rows] = await connection.query(
            "SELECT id, name, price, location, address, landmarks, description, bedrooms, bathrooms, status FROM properties WHERE id = ?",
            [propertyId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Property not found" });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error("Error fetching property:", err);
        res.status(500).json({ error: "Internal server error" });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

const PORT = 5050;

// ✅ Test DB connection before starting server
const startServer = async () => {
    try {
        const connection = await pool.getConnection(); // try to get a connection
        console.log("✅ MySQL connected successfully!");
        connection.release(); // release back to pool

        app.listen(PORT, () =>
            console.log(`🚀 Server running on http://localhost:${PORT}`)
        );
    } catch (err) {
        console.error("❌ Failed to connect to MySQL:", err.message);
        process.exit(1); // exit if db connection fails
    }
};

// ✅ Cronjob: hit the send-mails endpoint every 5 minutes
cron.schedule("*/5 * * * *", async () => {
    try {
        console.log("⏰ Cron job running: calling /api/sales/send-mails");
        const response = await fetch("http://localhost:5050/api/sales/send-mails");
        const data = await response.json();
        console.log("📧 Cron job result:", data);
    } catch (err) {
        console.error("❌ Cron job failed:", err.message);
    }
});

startServer();