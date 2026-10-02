const bcrypt = require("bcryptjs");
const pool = require("./database");

const DEFAULT_ADMIN = {
    name: "System Administrator",
    email: "admin@rainbowcarpet.com",
    phone: "+91 90000 00000",
    password: "Rainbow@123",
    role: "SUPER_ADMIN"
};

async function ensureDefaultAdminUser() {
    try {
        const [roleRows] = await pool.query(
            "SELECT id FROM roles WHERE name = ? LIMIT 1",
            [DEFAULT_ADMIN.role]
        );

        if (roleRows.length === 0) {
            console.warn("[bootstrap] SUPER_ADMIN role not found. Skipping default admin creation.");
            return;
        }

        const [existing] = await pool.query(
            "SELECT id FROM users WHERE email = ? LIMIT 1",
            [DEFAULT_ADMIN.email]
        );

        if (existing.length > 0) {
            return;
        }

        const passwordHash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);

        await pool.query(
            `
            INSERT INTO users (
                role_id,
                name,
                email,
                phone,
                password_hash,
                status
            ) VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
                roleRows[0].id,
                DEFAULT_ADMIN.name,
                DEFAULT_ADMIN.email,
                DEFAULT_ADMIN.phone,
                passwordHash,
                "ACTIVE"
            ]
        );

        console.log("[bootstrap] Default admin account created successfully.");
        console.log("[bootstrap] Login: admin@rainbowcarpet.com / Rainbow@123");
    } catch (error) {
        console.error("[bootstrap] Default admin seed failed:", error.message);
    }
}

module.exports = {
    ensureDefaultAdminUser,
    DEFAULT_ADMIN
};
