const bcrypt = require("bcryptjs");
const pool = require("../config/database");

// ==========================================
// 1. GET ALL SYSTEM USERS
// ==========================================
const getUsers = async (req, res) => {
    try {
        const { search, role, status } = req.query;

        let query = `
            SELECT 
                u.id,
                u.employee_id,
                u.role_id,
                u.name,
                u.email,
                u.phone,
                u.status,
                u.last_login,
                u.created_at,
                r.name AS role_name,
                r.description AS role_description,
                COALESCE(e.employee_code, e2.employee_code) AS employee_code,
                COALESCE(e.department, e2.department) AS department,
                COALESCE(e.designation, e2.designation) AS designation
            FROM users u
            LEFT JOIN roles r ON r.id = u.role_id
            LEFT JOIN employees e ON e.id = u.employee_id
            LEFT JOIN employees e2 ON e2.email = u.email AND e.id IS NULL
            WHERE 1=1
        `;

        const params = [];

        if (role && role !== "ALL") {
            query += ` AND r.name = ?`;
            params.push(role);
        }

        if (status && status !== "ALL") {
            query += ` AND u.status = ?`;
            params.push(status);
        }

        if (search && search.trim()) {
            query += ` AND (u.name LIKE ? OR u.email LIKE ? OR e.employee_code LIKE ? OR e.department LIKE ? OR e.designation LIKE ?)`;
            const term = `%${search.trim()}%`;
            params.push(term, term, term, term, term);
        }

        query += ` ORDER BY u.id DESC`;

        const [rows] = await pool.query(query, params);

        // Fetch aggregate stats
        const [[stats]] = await pool.query(`
            SELECT 
                COUNT(*) AS total_users,
                SUM(CASE WHEN u.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_users,
                SUM(CASE WHEN u.status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive_users,
                (
                    SELECT COUNT(*)
                    FROM employees e
                    LEFT JOIN users u2 ON u2.email = e.email
                    WHERE e.status = 'ACTIVE' AND u2.id IS NULL
                ) AS unlinked_employees
            FROM users u
        `);

        return res.json({
            success: true,
            count: rows.length,
            stats: stats || { total_users: rows.length, active_users: rows.length, inactive_users: 0, unlinked_employees: 0 },
            data: rows
        });
    } catch (error) {
        console.error("Get users error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch users",
            error: error.message
        });
    }
};

// ==========================================
// 2. GET AVAILABLE ROLES
// ==========================================
const getRoles = async (req, res) => {
    try {
        const [roles] = await pool.query(`
            SELECT id, name, description 
            FROM roles 
            ORDER BY id ASC
        `);

        return res.json({
            success: true,
            data: roles
        });
    } catch (error) {
        console.error("Get roles error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch roles",
            error: error.message
        });
    }
};

// ==========================================
// 3. GET ELIGIBLE EMPLOYEES (NO USER ACCOUNT YET)
// ==========================================
const getEligibleEmployees = async (req, res) => {
    try {
        const [employees] = await pool.query(`
            SELECT 
                e.id,
                e.employee_code,
                e.name,
                e.phone,
                e.email,
                e.department,
                e.designation,
                e.shift,
                e.status
            FROM employees e
            LEFT JOIN users u ON u.email = e.email
            WHERE e.status = 'ACTIVE'
              AND u.id IS NULL
            ORDER BY e.name ASC
        `);

        return res.json({
            success: true,
            count: employees.length,
            data: employees
        });
    } catch (error) {
        console.error("Get eligible employees error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch eligible employees",
            error: error.message
        });
    }
};

// ==========================================
// 4. CREATE USER (STRICTLY FROM EXISTING EMPLOYEE)
// ==========================================
const createUser = async (req, res) => {
    try {
        const {
            employee_id,
            role_id,
            email,
            password,
            status = "ACTIVE"
        } = req.body;

        if (!role_id) {
            return res.status(400).json({
                success: false,
                message: "Role selection is required."
            });
        }

        if (!password || password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password is required and must be at least 6 characters long."
            });
        }

        let employee = null;

        if (employee_id) {
            const [employeeRows] = await pool.query(
                `SELECT id, employee_code, name, phone, email, status FROM employees WHERE id = ?`,
                [employee_id]
            );

            if (employeeRows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Selected employee not found in employee records."
                });
            }

            employee = employeeRows[0];

            const [existingUserByEmp] = await pool.query(
                `SELECT id, name, email FROM users WHERE email = ?`,
                [employee.email]
            );

            if (existingUserByEmp.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `Employee "${employee.name}" (${employee.employee_code}) already has a user account (${existingUserByEmp[0].email}).`
                });
            }
        }

        const finalName = employee?.name || (req.body.name || "System User");
        const finalEmail = (email && email.trim())
            ? email.trim().toLowerCase()
            : (employee?.email && employee.email.trim())
                ? employee.email.trim().toLowerCase()
                : `${(employee?.employee_code || "user").toLowerCase()}@rainbowcarpet.com`;

        const [existingEmail] = await pool.query(
            `SELECT id FROM users WHERE email = ?`,
            [finalEmail]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: `Email "${finalEmail}" is already registered to another user.`
            });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const [result] = await pool.query(
            `
            INSERT INTO users (
                employee_id,
                role_id,
                name,
                email,
                phone,
                password_hash,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
                employee?.id || null,
                role_id,
                finalName,
                finalEmail,
                employee?.phone || req.body.phone || null,
                password_hash,
                status || "ACTIVE"
            ]
        );

        return res.status(201).json({
            success: true,
            message: `User login created successfully for ${finalName} (${finalEmail})`,
            id: result.insertId,
            user: {
                id: result.insertId,
                employee_id: employee?.id || null,
                name: finalName,
                email: finalEmail,
                role_id,
                status: status || "ACTIVE"
            }
        });
    } catch (error) {
        console.error("Create user error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create user account",
            error: error.message
        });
    }
};

// ==========================================
// 5. UPDATE USER (ROLE, STATUS, PHONE, EMAIL)
// ==========================================
const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { role_id, email, phone, status } = req.body;

        const [userRows] = await pool.query(`SELECT * FROM users WHERE id = ?`, [id]);
        if (userRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const currentUser = userRows[0];

        // Super Admin safety
        if (currentUser.id === 1 && status === "INACTIVE") {
            return res.status(400).json({
                success: false,
                message: "Root Super Administrator cannot be deactivated."
            });
        }

        const updatedEmail = email ? email.trim().toLowerCase() : currentUser.email;

        // Check if email already exists for another user
        if (updatedEmail !== currentUser.email) {
            const [dupEmail] = await pool.query(
                `SELECT id FROM users WHERE email = ? AND id != ?`,
                [updatedEmail, id]
            );
            if (dupEmail.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `Email "${updatedEmail}" is already taken.`
                });
            }
        }

        await pool.query(
            `
            UPDATE users 
            SET 
                role_id = COALESCE(?, role_id),
                email = ?,
                phone = COALESCE(?, phone),
                status = COALESCE(?, status)
            WHERE id = ?
            `,
            [role_id || currentUser.role_id, updatedEmail, phone || currentUser.phone, status || currentUser.status, id]
        );

        return res.json({
            success: true,
            message: "User updated successfully"
        });
    } catch (error) {
        console.error("Update user error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update user",
            error: error.message
        });
    }
};

// ==========================================
// 6. RESET USER PASSWORD
// ==========================================
const resetPassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password || new_password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "New password must be at least 6 characters long."
            });
        }

        const [users] = await pool.query(`SELECT id, name FROM users WHERE id = ?`, [id]);
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const password_hash = await bcrypt.hash(new_password, 10);

        await pool.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [password_hash, id]);

        return res.json({
            success: true,
            message: `Password reset successfully for ${users[0].name}`
        });
    } catch (error) {
        console.error("Reset password error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to reset password",
            error: error.message
        });
    }
};

// ==========================================
// 7. TOGGLE USER STATUS (ACTIVE / INACTIVE)
// ==========================================
const toggleUserStatus = async (req, res) => {
    try {
        const { id } = req.params;

        if (Number(id) === 1) {
            return res.status(400).json({
                success: false,
                message: "Cannot deactivate root Super Administrator."
            });
        }

        const [users] = await pool.query(`SELECT id, status, name FROM users WHERE id = ?`, [id]);
        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const newStatus = users[0].status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

        await pool.query(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, id]);

        return res.json({
            success: true,
            message: `User ${users[0].name} is now ${newStatus}`,
            status: newStatus
        });
    } catch (error) {
        console.error("Toggle user status error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to toggle status",
            error: error.message
        });
    }
};

// ==========================================
// 8. DELETE USER
// ==========================================
const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;

        if (Number(id) === 1) {
            return res.status(400).json({
                success: false,
                message: "Cannot delete root Super Administrator."
            });
        }

        const [result] = await pool.query(`DELETE FROM users WHERE id = ?`, [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.json({
            success: true,
            message: "User deleted successfully. The linked employee can now be assigned a new account if needed."
        });
    } catch (error) {
        console.error("Delete user error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete user",
            error: error.message
        });
    }
};

module.exports = {
    getUsers,
    getRoles,
    getEligibleEmployees,
    createUser,
    updateUser,
    resetPassword,
    toggleUserStatus,
    deleteUser
};
