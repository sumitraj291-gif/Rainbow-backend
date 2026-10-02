const pool = require("../config/database");

const PVC_FIELDS = `
    p.id,
    p.product_code,
    p.category_id,

    pc.name AS category_name,
    pc.name AS category_code,

    p.product_name,

    p.carpet_type,
    p.design_pattern,
    p.colour,

    p.width_mm,
    p.length_m,
    p.thickness_mm,
    p.gsm,

    p.surface_finish,
    p.backing_type,
    p.packing_type,

    p.standard_production_time,

    p.standard_cost,
    p.selling_price,

    p.unit_id,

    u.symbol AS unit_code,
    u.name AS unit_name,

    p.status,
    p.created_at,
    p.updated_at,

    COALESCE(
        (
            SELECT COUNT(*)
            FROM product_processes pp
            WHERE pp.product_id = p.id
        ),
        0
    ) AS process_count
`;

const getProducts = async (req, res) => {
    try {
        const {
            search = "",
            status = ""
        } = req.query;

        let sql = `
            SELECT ${PVC_FIELDS}
            FROM products p
            LEFT JOIN units u
                ON u.id = p.unit_id
            LEFT JOIN product_categories pc
                ON pc.id = p.category_id
            WHERE 1 = 1
        `;

        const params = [];

        if (search.trim()) {
            sql += `
                AND (
                    p.product_code LIKE ?
                    OR p.product_name LIKE ?
                    OR COALESCE(p.carpet_type, '') LIKE ?
                    OR COALESCE(p.colour, '') LIKE ?
                    OR COALESCE(p.design_pattern, '') LIKE ?
                )
            `;

            const q = `%${search.trim()}%`;

            params.push(
                q,
                q,
                q,
                q,
                q
            );
        }

        if (status) {
            sql += ` AND p.status = ?`;
            params.push(status);
        }

        sql += `
            ORDER BY p.created_at DESC
        `;

        const [rows] = await pool.query(
            sql,
            params
        );

        return res.json({
            success: true,
            data: rows
        });

    } catch (error) {
        console.error(
            "Get Products Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to load products",
            error: error.message
        });
    }
};

const getProductById = async (req, res) => {
    try {
        const [rows] = await pool.query(
            `
            SELECT ${PVC_FIELDS}
            FROM products p
            LEFT JOIN units u
                ON u.id = p.unit_id
            LEFT JOIN product_categories pc
                ON pc.id = p.category_id
            WHERE p.id = ?
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Product not found"
            });
        }

        const [routing] = await pool.query(`
            SELECT
                pp.id,
                pp.sequence_no,
                pp.process_id,
                pr.process_code,
                pr.process_name,
                pr.department,
                pp.machine_id,
                m.machine_code,
                m.machine_name,
                pp.standard_output_per_hour,
                pp.setup_minutes,
                pp.mandatory,
                pp.remarks
            FROM product_processes pp
            INNER JOIN processes pr
                ON pr.id = pp.process_id
            LEFT JOIN machines m
                ON m.id = pp.machine_id
            WHERE pp.product_id = ?
            ORDER BY pp.sequence_no
        `, [req.params.id]);

        return res.json({
            success: true,
            data: {
                ...rows[0],
                routing
            }
        });

    } catch (error) {
        console.error(
            "Get Product Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to load product",
            error: error.message
        });
    }
};

const getProductOptions = async (req, res) => {
    try {
        const [products] = await pool.query(`
            SELECT
                id,
                product_code,
                product_name,
                unit_id
            FROM products
            WHERE status = 'ACTIVE'
            ORDER BY product_name
        `);

        const [units] = await pool.query(`
          SELECT
        id,
        symbol AS unit_code,
        name AS unit_name
    FROM units
    ORDER BY name
`);

        const [categories] = await pool.query(`
          SELECT
        id,
        name AS category_code,
        name AS category_name
    FROM product_categories
    ORDER BY name
`);

        return res.json({
            success: true,
            data: {
                products,
                units,
                categories
            }
        });

    } catch (error) {
        console.error(
            "Product Options Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to load product options",
            error: error.message
        });
    }
};

const createProduct = async (req, res) => {
    const connection =
        await pool.getConnection();

    try {
        const {
    product_code,
    category_id,
    product_name,
    carpet_type,
    design_pattern,
    colour,
    width_mm,
    length_m,
    thickness_mm,
    gsm,
    surface_finish,
    backing_type,
    packing_type,
    standard_production_time,
    standard_cost,
    selling_price,
    unit_id,
    status
} = req.body;

        if (
            !product_code?.trim() ||
            !product_name?.trim()
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Product code and product name are required"
            });
        }

        if (
            Number(width_mm) < 0 ||
            Number(length_m) < 0 ||
            Number(thickness_mm) < 0 ||
            Number(gsm) < 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Physical specifications cannot be negative"
            });
        }

        if (
            Number(standard_cost) < 0 ||
            Number(selling_price) < 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Cost and selling price cannot be negative"
            });
        }

        const [duplicate] =
            await connection.query(
                `
                SELECT id
                FROM products
                WHERE product_code = ?
                LIMIT 1
                `,
                [product_code.trim()]
            );

        if (duplicate.length) {
            return res.status(409).json({
                success: false,
                message:
                    "Product code already exists"
            });
        }

        const [result] =
            await connection.query(
                `
                INSERT INTO products
(
    product_code,
    category_id,
    product_name,
    carpet_type,
    design_pattern,
    colour,
    width_mm,
    length_m,
    thickness_mm,
    gsm,
    surface_finish,
    backing_type,
    packing_type,
    standard_production_time,
    standard_cost,
    selling_price,
    unit_id,
    status
)
VALUES
(
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?
)`,
                [
    product_code.trim(),
    category_id || null,
    product_name.trim(),

    carpet_type || null,
    design_pattern || null,
    colour || null,

    width_mm ?? null,
    length_m ?? null,
    thickness_mm ?? null,
    gsm ?? null,

    surface_finish || null,
    backing_type || null,
    packing_type || null,

    standard_production_time ?? null,

    standard_cost ?? 0,
    selling_price ?? 0,

    unit_id || null,
    status
]
            );

        return res.status(201).json({
            success: true,
            message:
                "PVC carpet product created successfully",
            data: {
                id: result.insertId
            }
        });

    } catch (error) {
        console.error(
            "Create Product Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to create product",
            error: error.message
        });

    } finally {
        connection.release();
    }
};

const updateProduct = async (req, res) => {
    const connection =
        await pool.getConnection();

    try {
        const { id } = req.params;

        const {
            product_code,
            category_id,
            product_name,
            carpet_type,
            design_pattern,
            colour,
            width_mm,
            length_m,
            thickness_mm,
            gsm,
            surface_finish,
            backing_type,
            packing_type,
            standard_cost,
            selling_price,
            unit_id,
            status = "ACTIVE"
        } = req.body;

        if (
            !product_code?.trim() ||
            !product_name?.trim()
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Product code and product name are required"
            });
        }

        if (
            Number(width_mm) < 0 ||
            Number(length_m) < 0 ||
            Number(thickness_mm) < 0 ||
            Number(gsm) < 0 ||
            Number(standard_cost) < 0 ||
            Number(selling_price) < 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Numeric product values cannot be negative"
            });
        }

        const [existing] =
            await connection.query(
                `
                SELECT id
                FROM products
                WHERE id = ?
                LIMIT 1
                `,
                [id]
            );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Product not found"
            });
        }

        const [duplicate] =
            await connection.query(
                `
                SELECT id
                FROM products
                WHERE product_code = ?
                  AND id <> ?
                LIMIT 1
                `,
                [
                    product_code.trim(),
                    id
                ]
            );

        if (duplicate.length) {
            return res.status(409).json({
                success: false,
                message:
                    "Product code already exists"
            });
        }

        await connection.query(
            `
            UPDATE products
            SET
                product_code = ?,
                category_id = ?,
                product_name = ?,
                carpet_type = ?,
                design_pattern = ?,
                colour = ?,
                width_mm = ?,
                length_m = ?,
                thickness_mm = ?,
                gsm = ?,
                surface_finish = ?,
                backing_type = ?,
                packing_type = ?,
                standard_cost = ?,
                selling_price = ?,
                unit_id = ?,
                status = ?
            WHERE id = ?
            `,
            [
                product_code.trim(),
                category_id || null,
                product_name.trim(),
                carpet_type || null,
                design_pattern || null,
                colour || null,
                width_mm ?? null,
                length_m ?? null,
                thickness_mm ?? null,
                gsm ?? null,
                surface_finish || null,
                backing_type || null,
                packing_type || null,
                standard_cost ?? 0,
                selling_price ?? 0,
                unit_id || null,
                status,
                id
            ]
        );

        return res.json({
            success: true,
            message:
                "PVC carpet product updated successfully"
        });

    } catch (error) {
        console.error(
            "Update Product Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to update product",
            error: error.message
        });

    } finally {
        connection.release();
    }
};

const deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;

        const [orders] =
            await pool.query(
                `
                SELECT id
                FROM production_orders
                WHERE product_id = ?
                LIMIT 1
                `,
                [id]
            );

        if (orders.length) {
            return res.status(409).json({
                success: false,
                message:
                    "Product is used in production orders. Set it INACTIVE instead."
            });
        }

        await pool.query(
            `
            DELETE FROM product_processes
            WHERE product_id = ?
            `,
            [id]
        );

        const [result] =
            await pool.query(
                `
                DELETE FROM products
                WHERE id = ?
                `,
                [id]
            );

        if (!result.affectedRows) {
            return res.status(404).json({
                success: false,
                message: "Product not found"
            });
        }

        return res.json({
            success: true,
            message:
                "Product deleted successfully"
        });

    } catch (error) {
        console.error(
            "Delete Product Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to delete product",
            error: error.message
        });
    }
};

module.exports = {
    getProducts,
    getProductById,
    getProductOptions,
    createProduct,
    updateProduct,
    deleteProduct
};
