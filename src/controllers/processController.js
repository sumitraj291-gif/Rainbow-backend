const pool = require("../config/database");

const getProcesses = async (req, res) => {
    try {
        const { search = "", status = "" } = req.query;

        let sql = `
            SELECT
                id,
                process_code,
                process_name,
                department,
                machine_required,
                standard_output_per_hour,
                standard_setup_minutes,
                status,
                remarks,
                created_at,
                updated_at
            FROM processes
            WHERE 1=1
        `;
        const params = [];

        if (search.trim()) {
            sql += ` AND (process_code LIKE ? OR process_name LIKE ? OR COALESCE(department,'') LIKE ?)`;
            const q = `%${search.trim()}%`;
            params.push(q, q, q);
        }

        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY process_name`;

        const [rows] = await pool.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error("Get Processes Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load processes",
            error: error.message
        });
    }
};

const getProcessOptions = async (req, res) => {
    try {
        const [machines] = await pool.query(`
            SELECT id, machine_code, machine_name, machine_type
            FROM machines
            WHERE status <> 'INACTIVE'
            ORDER BY machine_name
        `);

        res.json({
            success: true,
            data: { machines }
        });
    } catch (error) {
        console.error("Process Options Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load process options",
            error: error.message
        });
    }
};

const createProcess = async (req, res) => {
    try {
        const {
            process_code,
            process_name,
            department,
            machine_required = 0,
            standard_output_per_hour,
            standard_setup_minutes = 0,
            status = "ACTIVE",
            remarks
        } = req.body;

        if (!process_code?.trim() || !process_name?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Process code and process name are required"
            });
        }

        const [duplicate] = await pool.query(
            `SELECT id FROM processes WHERE process_code = ? LIMIT 1`,
            [process_code.trim()]
        );

        if (duplicate.length) {
            return res.status(409).json({
                success: false,
                message: "Process code already exists"
            });
        }

        const [result] = await pool.query(`
            INSERT INTO processes
            (
                process_code,
                process_name,
                department,
                machine_required,
                standard_output_per_hour,
                standard_setup_minutes,
                status,
                remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            process_code.trim(),
            process_name.trim(),
            department || null,
            machine_required ? 1 : 0,
            standard_output_per_hour || null,
            standard_setup_minutes || 0,
            status,
            remarks || null
        ]);

        res.status(201).json({
            success: true,
            message: "Process created successfully",
            data: { id: result.insertId }
        });
    } catch (error) {
        console.error("Create Process Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to create process",
            error: error.message
        });
    }
};

const updateProcess = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            process_code,
            process_name,
            department,
            machine_required = 0,
            standard_output_per_hour,
            standard_setup_minutes = 0,
            status = "ACTIVE",
            remarks
        } = req.body;

        if (!process_code?.trim() || !process_name?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Process code and process name are required"
            });
        }

        const [existing] = await pool.query(
            `SELECT id FROM processes WHERE id = ? LIMIT 1`,
            [id]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Process not found"
            });
        }

        const [duplicate] = await pool.query(
            `SELECT id FROM processes
             WHERE process_code = ? AND id <> ?
             LIMIT 1`,
            [process_code.trim(), id]
        );

        if (duplicate.length) {
            return res.status(409).json({
                success: false,
                message: "Process code already exists"
            });
        }

        await pool.query(`
            UPDATE processes SET
                process_code = ?,
                process_name = ?,
                department = ?,
                machine_required = ?,
                standard_output_per_hour = ?,
                standard_setup_minutes = ?,
                status = ?,
                remarks = ?
            WHERE id = ?
        `, [
            process_code.trim(),
            process_name.trim(),
            department || null,
            machine_required ? 1 : 0,
            standard_output_per_hour || null,
            standard_setup_minutes || 0,
            status,
            remarks || null,
            id
        ]);

        res.json({
            success: true,
            message: "Process updated successfully"
        });
    } catch (error) {
        console.error("Update Process Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update process",
            error: error.message
        });
    }
};

const deleteProcess = async (req, res) => {
    try {
        const { id } = req.params;

        const [used] = await pool.query(
            `SELECT id FROM product_processes WHERE process_id = ? LIMIT 1`,
            [id]
        );

        if (used.length) {
            return res.status(409).json({
                success: false,
                message: "Process is used in product routing. Set it INACTIVE instead."
            });
        }

        const [result] = await pool.query(
            `DELETE FROM processes WHERE id = ?`,
            [id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                success: false,
                message: "Process not found"
            });
        }

        res.json({
            success: true,
            message: "Process deleted successfully"
        });
    } catch (error) {
        console.error("Delete Process Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to delete process",
            error: error.message
        });
    }
};

module.exports = {
    getProcesses,
    getProcessOptions,
    createProcess,
    updateProcess,
    deleteProcess
};
