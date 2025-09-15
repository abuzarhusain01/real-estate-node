// db.js
import mysql from "mysql2/promise";

const pool = mysql.createPool({
    host: "127.0.0.1",
    user: "root",
    password: "",
    database: "PropertyApp",
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
});

export default pool;
