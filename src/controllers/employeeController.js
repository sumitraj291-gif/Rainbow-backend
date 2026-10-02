const pool = require("../config/database");

/*
=========================================================
HELPER: AUTO-GENERATE EMPLOYEE CODE
=========================================================
*/
const generateNextEmployeeCode = async () => {
    try {
        const [rows] = await pool.query(`
            SELECT employee_code
            FROM employees
            WHERE employee_code LIKE 'EMP-%'
            ORDER BY id DESC
            LIMIT 1
        `);

        if (rows.length === 0) {
            return "EMP-001";
        }

        const lastCode = rows[0].employee_code;
        const match = lastCode.match(/EMP-(\d+)/i);
        if (match && match[1]) {
            const nextNum = parseInt(match[1], 10) + 1;
            return `EMP-${String(nextNum).padStart(3, "0")}`;
        }

        const [countRow] = await pool.query("SELECT COUNT(*) AS total FROM employees");
        const nextId = (countRow[0].total || 0) + 1;
        return `EMP-${String(nextId).padStart(3, "0")}`;
    } catch {
        return `EMP-${Date.now().toString().slice(-4)}`;
    }
};

/*
=========================================================
GET ALL EMPLOYEES
=========================================================
*/
const getEmployees = async (req, res) => {
    try {
        const { search, department, shift, status } = req.query;

        let query = `
            SELECT
                id,
                employee_code,
                name,
                phone,
                email,
                department,
                designation,
                joining_date,
                shift,
                status,
                created_at,
                updated_at
            FROM employees
            WHERE 1=1
        `;

        const params = [];

        if (search && search.trim()) {
            const searchTerm = `%${search.trim()}%`;
            query += ` AND (
                employee_code LIKE ?
                OR name LIKE ?
                OR phone LIKE ?
                OR email LIKE ?
                OR designation LIKE ?
                OR department LIKE ?
            )`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        if (department && department !== "ALL") {
            query += ` AND department = ?`;
            params.push(department);
        }

        if (shift && shift !== "ALL") {
            query += ` AND shift = ?`;
            params.push(shift);
        }

        if (status && status !== "ALL") {
            query += ` AND status = ?`;
            params.push(status);
        }

        query += ` ORDER BY name ASC`;

        const [rows] = await pool.query(query, params);

        // Compute high-level stats from database
        const [statsRows] = await pool.query(`
            SELECT
                COUNT(*) AS total,
                IFNULL(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active_count,
                IFNULL(SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END), 0) AS inactive_count,
                IFNULL(SUM(CASE WHEN department = 'PRODUCTION' THEN 1 ELSE 0 END), 0) AS production_count,
                IFNULL(SUM(CASE WHEN department = 'MAINTENANCE' THEN 1 ELSE 0 END), 0) AS maintenance_count,
                IFNULL(SUM(CASE WHEN department = 'QUALITY_CONTROL' OR department = 'QUALITY' THEN 1 ELSE 0 END), 0) AS qc_count
            FROM employees
        `);

        res.json({
            success: true,
            count: rows.length,
            data: rows,
            stats: statsRows[0] || {
                total: 0,
                active_count: 0,
                inactive_count: 0,
                production_count: 0,
                maintenance_count: 0,
                qc_count: 0
            }
        });

    } catch (error) {
        console.error("Get Employees Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load employees",
            error: error.message
        });
    }
};

/*
=========================================================
GET EMPLOYEE STATS / METRICS
=========================================================
*/
const getEmployeeStats = async (req, res) => {
    try {
        const [overview] = await pool.query(`
            SELECT
                COUNT(*) AS total,
                IFNULL(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active,
                IFNULL(SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END), 0) AS inactive,
                IFNULL(SUM(CASE WHEN shift = 'DAY' THEN 1 ELSE 0 END), 0) AS shift_day,
                IFNULL(SUM(CASE WHEN shift = 'NIGHT' THEN 1 ELSE 0 END), 0) AS shift_night,
                IFNULL(SUM(CASE WHEN shift = 'GENERAL' THEN 1 ELSE 0 END), 0) AS shift_general,
                IFNULL(SUM(CASE WHEN shift = 'ROTATIONAL' THEN 1 ELSE 0 END), 0) AS shift_rotational
            FROM employees
        `);

        const [deptBreakdown] = await pool.query(`
            SELECT
                IFNULL(department, 'Unassigned') AS department,
                COUNT(*) AS count
            FROM employees
            GROUP BY department
            ORDER BY count DESC
        `);

        res.json({
            success: true,
            data: {
                overview: overview[0] || {},
                departmentBreakdown: deptBreakdown || []
            }
        });
    } catch (error) {
        console.error("Get Employee Stats Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load employee metrics",
            error: error.message
        });
    }
};

/*
=========================================================
GET EMPLOYEE OPTIONS (DROPDOWN LIST)
=========================================================
*/
const getEmployeeOptions = async (req, res) => {
    try {
        const { department, shift, active_only } = req.query;

        let query = `
            SELECT
                id,
                employee_code,
                name,
                department,
                designation,
                shift,
                status
            FROM employees
            WHERE 1=1
        `;

        const params = [];

        if (active_only !== "false") {
            query += ` AND status = 'ACTIVE'`;
        }

        if (department && department !== "ALL") {
            query += ` AND department = ?`;
            params.push(department);
        }

        if (shift && shift !== "ALL") {
            query += ` AND shift = ?`;
            params.push(shift);
        }

        query += ` ORDER BY name ASC`;

        const [rows] = await pool.query(query, params);

        res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error("Get Employee Options Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load employee options",
            error: error.message
        });
    }
};

/*
=========================================================
GET EMPLOYEE BY ID
=========================================================
*/
const getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(`
            SELECT
                id,
                employee_code,
                name,
                phone,
                email,
                department,
                designation,
                joining_date,
                shift,
                status,
                created_at,
                updated_at
            FROM employees
            WHERE id = ?
            LIMIT 1
        `, [id]);

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const employee = rows[0];

        // Fetch activity summary counts
        let rollsCount = 0;
        let entriesCount = 0;
        let inspectionsCount = 0;

        try {
            const [rc] = await pool.query("SELECT COUNT(*) AS total FROM carpet_rolls WHERE operator_id = ?", [id]);
            rollsCount = rc[0]?.total || 0;
        } catch {}

        try {
            const [pe] = await pool.query("SELECT COUNT(*) AS total FROM production_entries WHERE operator_id = ?", [id]);
            entriesCount = pe[0]?.total || 0;
        } catch {}

        try {
            const [ic] = await pool.query("SELECT COUNT(*) AS total FROM carpet_roll_inspections WHERE inspector_id = ?", [id]);
            inspectionsCount = ic[0]?.total || 0;
        } catch {}

        res.json({
            success: true,
            data: {
                ...employee,
                activity: {
                    rolls_count: rollsCount,
                    production_entries_count: entriesCount,
                    inspections_count: inspectionsCount
                }
            }
        });

    } catch (error) {
        console.error("Get Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load employee",
            error: error.message
        });
    }
};

/*
=========================================================
CREATE EMPLOYEE
=========================================================
*/
const createEmployee = async (req, res) => {
    try {
        let {
            employee_code,
            name,
            phone,
            email,
            department,
            designation,
            joining_date,
            shift,
            status
        } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Employee name is required"
            });
        }

        // Auto-generate code if empty
        if (!employee_code || !employee_code.trim()) {
            employee_code = await generateNextEmployeeCode();
        } else {
            employee_code = employee_code.trim().toUpperCase();
        }

        // Check uniqueness of employee code
        const [existing] = await pool.query(`
            SELECT id FROM employees WHERE employee_code = ? LIMIT 1
        `, [employee_code]);

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: `Employee code '${employee_code}' already exists`
            });
        }

        const validShifts = ["GENERAL", "DAY", "NIGHT", "ROTATIONAL"];
        const validStatuses = ["ACTIVE", "INACTIVE"];

        const employeeShift = validShifts.includes(shift) ? shift : "GENERAL";
        const employeeStatus = validStatuses.includes(status) ? status : "ACTIVE";

        const [result] = await pool.query(`
            INSERT INTO employees
            (
                employee_code,
                name,
                phone,
                email,
                department,
                designation,
                joining_date,
                shift,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            employee_code,
            name.trim(),
            phone ? phone.trim() : null,
            email ? email.trim() : null,
            department ? department.trim() : null,
            designation ? designation.trim() : null,
            joining_date || null,
            employeeShift,
            employeeStatus
        ]);

        res.status(201).json({
            success: true,
            message: "Employee created successfully",
            data: {
                id: result.insertId,
                employee_code
            }
        });

    } catch (error) {
        console.error("Create Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to create employee",
            error: error.message
        });
    }
};

/*
=========================================================
UPDATE EMPLOYEE
=========================================================
*/
const updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            employee_code,
            name,
            phone,
            email,
            department,
            designation,
            joining_date,
            shift,
            status
        } = req.body;

        const [current] = await pool.query("SELECT id FROM employees WHERE id = ? LIMIT 1", [id]);
        if (current.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Employee name is required"
            });
        }

        let cleanCode = employee_code ? employee_code.trim().toUpperCase() : null;
        if (cleanCode) {
            const [duplicate] = await pool.query(`
                SELECT id FROM employees WHERE employee_code = ? AND id != ? LIMIT 1
            `, [cleanCode, id]);

            if (duplicate.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: `Employee code '${cleanCode}' is already taken by another employee`
                });
            }
        }

        const validShifts = ["GENERAL", "DAY", "NIGHT", "ROTATIONAL"];
        const validStatuses = ["ACTIVE", "INACTIVE"];

        const employeeShift = validShifts.includes(shift) ? shift : "GENERAL";
        const employeeStatus = validStatuses.includes(status) ? status : "ACTIVE";

        await pool.query(`
            UPDATE employees
            SET
                employee_code = COALESCE(?, employee_code),
                name = ?,
                phone = ?,
                email = ?,
                department = ?,
                designation = ?,
                joining_date = ?,
                shift = ?,
                status = ?
            WHERE id = ?
        `, [
            cleanCode,
            name.trim(),
            phone ? phone.trim() : null,
            email ? email.trim() : null,
            department ? department.trim() : null,
            designation ? designation.trim() : null,
            joining_date || null,
            employeeShift,
            employeeStatus,
            id
        ]);

        res.json({
            success: true,
            message: "Employee updated successfully"
        });

    } catch (error) {
        console.error("Update Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update employee",
            error: error.message
        });
    }
};

/*
=========================================================
DELETE EMPLOYEE
=========================================================
*/
const deleteEmployee = async (req, res) => {
    try {
        const { id } = req.params;

        const [current] = await pool.query("SELECT * FROM employees WHERE id = ? LIMIT 1", [id]);
        if (current.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        // Check foreign key references
        const [rolls] = await pool.query(
            "SELECT COUNT(*) AS total FROM carpet_rolls WHERE operator_id = ?",
            [id]
        );
        if (rolls[0]?.total > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete employee: linked to ${rolls[0].total} carpet roll production records. Please mark status as INACTIVE instead.`
            });
        }

        const [entries] = await pool.query(
            "SELECT COUNT(*) AS total FROM production_entries WHERE operator_id = ?",
            [id]
        );
        if (entries[0]?.total > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete employee: linked to ${entries[0].total} production entry logs. Please mark status as INACTIVE instead.`
            });
        }

        await pool.query("DELETE FROM employees WHERE id = ?", [id]);

        res.json({
            success: true,
            message: "Employee deleted successfully"
        });

    } catch (error) {
        console.error("Delete Employee Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to delete employee",
            error: error.message
        });
    }
};

/*
=========================================================
SEED SAMPLE FACTORY EMPLOYEES
=========================================================
*/
const seedSampleEmployees = async (req, res) => {
    try {
        const sampleEmployees = [
            {
                employee_code: "EMP-001",
                name: "Rajesh Sharma",
                phone: "+91 98250 11221",
                email: "rajesh.sharma@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "Production Supervisor",
                joining_date: "2023-01-15",
                shift: "DAY",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-002",
                name: "Vikram Desai",
                phone: "+91 98250 22334",
                email: "vikram.desai@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "PVC Coating Line Lead Operator",
                joining_date: "2023-03-01",
                shift: "DAY",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-003",
                name: "Ramesh Yadav",
                phone: "+91 98250 33445",
                email: "ramesh.yadav@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "Plastisol Calendering Operator",
                joining_date: "2023-04-10",
                shift: "ROTATIONAL",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-004",
                name: "Amit Verma",
                phone: "+91 98250 44556",
                email: "amit.verma@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "Gravure Rotogravure Printing Lead",
                joining_date: "2023-06-20",
                shift: "DAY",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-005",
                name: "Sanjay Solanki",
                phone: "+91 98250 55667",
                email: "sanjay.solanki@rainbowcarpet.com",
                department: "MAINTENANCE",
                designation: "Senior Electrical & Automation Lead",
                joining_date: "2022-11-01",
                shift: "GENERAL",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-006",
                name: "Dinesh Joshi",
                phone: "+91 98250 66778",
                email: "dinesh.joshi@rainbowcarpet.com",
                department: "MAINTENANCE",
                designation: "Mechanical & Thermal Oil Technician",
                joining_date: "2023-02-15",
                shift: "GENERAL",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-007",
                name: "Priya Nair",
                phone: "+91 98250 77889",
                email: "priya.nair@rainbowcarpet.com",
                department: "QUALITY_CONTROL",
                designation: "Quality Assurance & Lab Inspector",
                joining_date: "2023-05-18",
                shift: "DAY",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-008",
                name: "Hardik Mehta",
                phone: "+91 98250 88990",
                email: "hardik.mehta@rainbowcarpet.com",
                department: "QUALITY_CONTROL",
                designation: "Roll Final Inspection Officer",
                joining_date: "2023-08-01",
                shift: "ROTATIONAL",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-009",
                name: "Manoj Patel",
                phone: "+91 98250 99001",
                email: "manoj.patel@rainbowcarpet.com",
                department: "WAREHOUSE",
                designation: "Dispatch & Finished Goods In-charge",
                joining_date: "2022-09-10",
                shift: "GENERAL",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-010",
                name: "Karan Patel",
                phone: "+91 98250 10102",
                email: "karan.patel@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "Chemical Mixer & Compounder",
                joining_date: "2023-09-01",
                shift: "DAY",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-011",
                name: "Suresh Kumar",
                phone: "+91 98250 11213",
                email: "suresh.kumar@rainbowcarpet.com",
                department: "PRODUCTION",
                designation: "Embossing & Lamination Tech",
                joining_date: "2023-10-15",
                shift: "NIGHT",
                status: "ACTIVE"
            },
            {
                employee_code: "EMP-012",
                name: "Mahesh Chawla",
                phone: "+91 98250 12314",
                email: "mahesh.chawla@rainbowcarpet.com",
                department: "MAINTENANCE",
                designation: "Plant Shift Mechanic",
                joining_date: "2024-01-05",
                shift: "NIGHT",
                status: "ACTIVE"
            }
        ];

        let insertedCount = 0;
        for (const emp of sampleEmployees) {
            const [exist] = await pool.query(
                "SELECT id FROM employees WHERE employee_code = ? LIMIT 1",
                [emp.employee_code]
            );

            if (exist.length === 0) {
                await pool.query(`
                    INSERT INTO employees
                    (
                        employee_code,
                        name,
                        phone,
                        email,
                        department,
                        designation,
                        joining_date,
                        shift,
                        status
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    emp.employee_code,
                    emp.name,
                    emp.phone,
                    emp.email,
                    emp.department,
                    emp.designation,
                    emp.joining_date,
                    emp.shift,
                    emp.status
                ]);
                insertedCount++;
            }
        }

        res.json({
            success: true,
            message: `Successfully seeded ${insertedCount} factory personnel records`,
            inserted: insertedCount
        });

    } catch (error) {
        console.error("Seed Employees Error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to seed employees",
            error: error.message
        });
    }
};

module.exports = {
    getEmployees,
    getEmployeeStats,
    getEmployeeOptions,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    seedSampleEmployees
};
