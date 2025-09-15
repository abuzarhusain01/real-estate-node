// routes/sales.js
import express from "express";
import pool from "../lib/db.js";
import nodemailer from "nodemailer";

const router = express.Router();

// ✅ Setup Nodemailer transporter (example: Gmail)
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: "unawazshah@gmail.com",     // replace with your Gmail
        pass: "ilwe vjxe kmvv ohvk",       // ⚠️ use App Password, not Gmail password
    },
});

// GET /api/sales/send-mails
router.get("/send-mails", async (req, res) => {
    try {
        // 1. Get new sales
        const [sales] = await pool.query(`
      SELECT id, name, email 
      FROM sales
      WHERE status = 'new'
      LIMIT 50
    `);

        if (sales.length === 0) {
            return res.json({ message: "No new sales found ✅" });
        }

        const results = [];
        // 2. Loop over each sale and send mail
        for (const sale of sales) {
            if (!sale.email) {
                console.log(`⚠️ Skipping ${sale.name} (no email)`);
                results.push({ id: sale.id, email: null, status: "skipped (no email)" });
                continue;
            }

            // Send email
            try {
                // Send email
                await transporter.sendMail({
                    from: '"Real Estate App" <unawazshah@gmail.com>',
                    to: sale.email,
                    subject: "Thank you for contacting us",
                    text: `Hello ${sale.name || "Customer"}, 
        Thank you for contacting our agent. We will get in touch with you soon.`,
                });

                console.log(`📧 Email sent to: ${sale.email}`);

                // Update DB
                await pool.query(`UPDATE sales SET status = 'connected' WHERE id = ?`, [
                    sale.id,
                ]);
                console.log(`✅ Status updated for ID: ${sale.id}`);

                results.push({ id: sale.id, email: sale.email, status: "sent & updated" });
            } catch (err) {
                // If email fails, skip and log
                console.error(`❌ Failed for ${sale.email}:`, err.message);
                results.push({ id: sale.id, email: sale.email, status: "failed (invalid email)" });
                continue;
            }
        }

        res.json({ message: "Emails sent and statuses updated ✅" });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: "Failed to send emails" });
    }
});

export default router;
