import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { URL } from "url";

dotenv.config();

let host = process.env.DB_HOST;
let port = process.env.DB_PORT;
let user = process.env.DB_USER;
let password = process.env.DB_PASS;
let database = process.env.DB_NAME;

// Minimal fix: if DB_HOST is a full URL (Railway), parse it
if (host.startsWith("mysql://")) {
    const dbUrl = new URL(host);
    host = dbUrl.hostname;
    port = dbUrl.port;
    user = dbUrl.username;
    password = dbUrl.password;
    database = dbUrl.pathname.replace(/^\//, "");
}

const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
});

export default pool;
