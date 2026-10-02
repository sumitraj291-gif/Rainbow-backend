const pool = require("../config/database");

/*
=========================================================
GET ALL MACHINES
=========================================================
*/
const getMachines = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name,
                machine_type,
                manufacturer,
                model_number,
                serial_number,
                capacity_per_hour,
                status,
                installation_date,
                created_at,
                updated_at
            FROM machines
            ORDER BY machine_name ASC
        `);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error("Get Machines Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load machines",
            error: error.message
        });
    }
};


/*
=========================================================
GET MACHINE BY ID
=========================================================
*/
const getMachineById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name,
                machine_type,
                manufacturer,
                model_number,
                serial_number,
                capacity_per_hour,
                status,
                installation_date,
                created_at,
                updated_at
            FROM machines
            WHERE id = ?
            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Machine not found"
            });
        }

        res.json({
            success: true,
            data: rows[0]
        });

    } catch (error) {
        console.error("Get Machine Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load machine",
            error: error.message
        });
    }
};


/*
=========================================================
GET MACHINE OPTIONS
=========================================================
*/
const getMachineOptions = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name,
                machine_type,
                status
            FROM machines
            WHERE status != 'INACTIVE'
            ORDER BY machine_name ASC
        `);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error("Get Machine Options Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load machine options",
            error: error.message
        });
    }
};


/*
=========================================================
CREATE MACHINE
=========================================================
*/
const createMachine = async (req, res) => {
    try {
        const {
            machine_code,
            machine_name,
            machine_type,
            manufacturer,
            model_number,
            serial_number,
            capacity_per_hour,
            status,
            installation_date
        } = req.body;

        if (!machine_code || !machine_code.trim()) {
            return res.status(400).json({
                success: false,
                message: "Machine code is required"
            });
        }

        if (!machine_name || !machine_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Machine name is required"
            });
        }

        const [existing] = await pool.query(`
            SELECT id
            FROM machines
            WHERE machine_code = ?
            LIMIT 1
        `, [machine_code.trim()]);

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Machine code already exists"
            });
        }

        const validStatuses = [
            "RUNNING",
            "IDLE",
            "BREAKDOWN",
            "MAINTENANCE",
            "INACTIVE"
        ];

        const machineStatus =
            validStatuses.includes(status)
                ? status
                : "IDLE";

        const [result] = await pool.query(`
            INSERT INTO machines
            (
                machine_code,
                machine_name,
                machine_type,
                manufacturer,
                model_number,
                serial_number,
                capacity_per_hour,
                status,
                installation_date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            machine_code.trim(),
            machine_name.trim(),
            machine_type || null,
            manufacturer || null,
            model_number || null,
            serial_number || null,
            capacity_per_hour || null,
            machineStatus,
            installation_date || null
        ]);

        res.status(201).json({
            success: true,
            message: "Machine created successfully",
            data: {
                id: result.insertId
            }
        });

    } catch (error) {
        console.error("Create Machine Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create machine",
            error: error.message
        });
    }
};


/*
=========================================================
UPDATE MACHINE
=========================================================
*/
const updateMachine = async (req, res) => {
    try {
        const { id } = req.params;

        const {
            machine_code,
            machine_name,
            machine_type,
            manufacturer,
            model_number,
            serial_number,
            capacity_per_hour,
            status,
            installation_date
        } = req.body;

        if (!machine_code || !machine_code.trim()) {
            return res.status(400).json({
                success: false,
                message: "Machine code is required"
            });
        }

        if (!machine_name || !machine_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Machine name is required"
            });
        }

        const [existing] = await pool.query(`
            SELECT id
            FROM machines
            WHERE id = ?
            LIMIT 1
        `, [id]);

        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Machine not found"
            });
        }

        const [duplicate] = await pool.query(`
            SELECT id
            FROM machines
            WHERE machine_code = ?
              AND id != ?
            LIMIT 1
        `, [
            machine_code.trim(),
            id
        ]);

        if (duplicate.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Machine code already exists"
            });
        }

        const validStatuses = [
            "RUNNING",
            "IDLE",
            "BREAKDOWN",
            "MAINTENANCE",
            "INACTIVE"
        ];

        const machineStatus =
            validStatuses.includes(status)
                ? status
                : "IDLE";

        await pool.query(`
            UPDATE machines
            SET
                machine_code = ?,
                machine_name = ?,
                machine_type = ?,
                manufacturer = ?,
                model_number = ?,
                serial_number = ?,
                capacity_per_hour = ?,
                status = ?,
                installation_date = ?
            WHERE id = ?
        `, [
            machine_code.trim(),
            machine_name.trim(),
            machine_type || null,
            manufacturer || null,
            model_number || null,
            serial_number || null,
            capacity_per_hour || null,
            machineStatus,
            installation_date || null,
            id
        ]);

        res.json({
            success: true,
            message: "Machine updated successfully"
        });

    } catch (error) {
        console.error("Update Machine Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update machine",
            error: error.message
        });
    }
};


/*
=========================================================
DELETE MACHINE
=========================================================
*/
const deleteMachine = async (req, res) => {
    try {
        const { id } = req.params;

        /*
        Prevent deletion when production history exists.
        */
        const [productionEntries] = await pool.query(`
            SELECT COUNT(*) AS total
            FROM production_entries
            WHERE machine_id = ?
        `, [id]);

        if (Number(productionEntries[0].total) > 0) {
            return res.status(400).json({
                success: false,
                message:
                    "This machine cannot be deleted because production entries already exist. Set it to INACTIVE instead."
            });
        }

        /*
        Prevent deletion when breakdown history exists.
        */
        const [breakdowns] = await pool.query(`
            SELECT COUNT(*) AS total
            FROM machine_breakdowns
            WHERE machine_id = ?
        `, [id]);

        if (Number(breakdowns[0].total) > 0) {
            return res.status(400).json({
                success: false,
                message:
                    "This machine cannot be deleted because breakdown history exists. Set it to INACTIVE instead."
            });
        }

        const [result] = await pool.query(`
            DELETE FROM machines
            WHERE id = ?
        `, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Machine not found"
            });
        }

        res.json({
            success: true,
            message: "Machine deleted successfully"
        });

    } catch (error) {
        console.error("Delete Machine Error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to delete machine",
            error: error.message
        });
    }
};

/*
=========================================================
UPDATE MACHINE STATUS
=========================================================
*/
const updateMachineStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = [
            "RUNNING",
            "IDLE",
            "BREAKDOWN",
            "MAINTENANCE",
            "INACTIVE"
        ];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid machine status. Valid values: ${validStatuses.join(", ")}`
            });
        }

        const [result] = await pool.query(
            `UPDATE machines SET status = ? WHERE id = ?`,
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Machine not found"
            });
        }

        res.json({
            success: true,
            message: `Machine status updated to ${status}`
        });
    } catch (error) {
        console.error("Update Machine Status Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update machine status",
            error: error.message
        });
    }
};

module.exports = {
    getMachines,
    getMachineById,
    getMachineOptions,
    createMachine,
    updateMachine,
    updateMachineStatus,
    deleteMachine
};