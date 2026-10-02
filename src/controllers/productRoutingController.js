const pool = require("../config/database");


// GET ROUTING BY PRODUCT

const getProductRouting = async (req, res) => {

    try {

        const { productId } = req.params;


        const [rows] = await pool.query(`

            SELECT

                pp.id,

                pp.product_id,

                pp.process_id,

                pp.sequence_no,

                pp.standard_output_per_hour,

                pp.setup_minutes,

                pp.mandatory,

                pp.remarks,


                pr.process_code,

                pr.process_name,

                pr.department,


                m.machine_code,

                m.machine_name


            FROM product_processes pp


            INNER JOIN processes pr
            ON pr.id = pp.process_id


            LEFT JOIN machines m
            ON m.id = pp.machine_id


            WHERE pp.product_id = ?


            ORDER BY pp.sequence_no ASC


        `,[productId]);



        res.json({

            success:true,

            data:rows

        });



    } catch(error){


        console.error(error);


        res.status(500).json({

            success:false,

            message:"Unable to load product routing",

            error:error.message

        });


    }

};





// CREATE ROUTING


const createProductRouting = async(req,res)=>{


    try{


        const {

            product_id,

            process_id,

            sequence_no,

            machine_id,

            standard_output_per_hour,

            setup_minutes,

            mandatory,

            remarks


        } = req.body;



        const seqNo = sequence_no || req.body.sequence_order;

        if (!product_id || !process_id || !seqNo) {

            return res.status(400).json({

                success: false,

                message: "Product, Process and Sequence are required"

            });

        }




        const [result]=await pool.query(`


            INSERT INTO product_processes

            (

                product_id,

                process_id,

                sequence_no,

                machine_id,

                standard_output_per_hour,

                setup_minutes,

                mandatory,

                remarks

            )


            VALUES(?,?,?,?,?,?,?,?)


        `,[

            product_id,

            process_id,

            seqNo,

            machine_id || null,

            standard_output_per_hour || null,

            setup_minutes || 0,

            mandatory ? 1:0,

            remarks || null

        ]);




        res.json({

            success:true,

            message:"Process added to product routing",

            id:result.insertId

        });



    }catch(error){


        console.error(error);


        res.status(500).json({

            success:false,

            message:"Unable to create routing",

            error:error.message

        });


    }


};






// DELETE ROUTING


const deleteProductRouting = async(req,res)=>{


    try{


        const {id}=req.params;



        await pool.query(

            "DELETE FROM product_processes WHERE id=?",

            [id]

        );



        res.json({

            success:true,

            message:"Routing process removed"

        });



    }catch(error){


        res.status(500).json({

            success:false,

            message:"Unable to delete routing",

            error:error.message

        });


    }


};





// OPTIONS


const getRoutingOptions = async(req,res)=>{


    try{


        const [products]=await pool.query(`
            SELECT
                id,
                product_code,
                product_name,
                carpet_type,
                colour,
                thickness_mm,
                gsm
            FROM products
            WHERE status='ACTIVE'
            ORDER BY product_name
        `);

        const [processes]=await pool.query(`
            SELECT
                id,
                process_code,
                process_name,
                department,
                standard_output_per_hour,
                standard_setup_minutes
            FROM processes
            WHERE status='ACTIVE'
            ORDER BY process_name
        `);

        const [machines]=await pool.query(`
            SELECT
                id,
                machine_code,
                machine_name
            FROM machines
            WHERE status <> 'INACTIVE'
            ORDER BY machine_name
        `);



        res.json({

            success:true,

            data:{

                products,

                processes,

                machines

            }

        });



    }catch(error){


        res.status(500).json({

            success:false,

            message:"Unable to load options",

            error:error.message

        });

    }


};





// UPDATE ROUTING STEP
const updateProductRouting = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            process_id,
            sequence_no,
            machine_id,
            standard_output_per_hour,
            setup_minutes,
            mandatory,
            remarks
        } = req.body;

        await pool.query(`
            UPDATE product_processes
            SET
                process_id = COALESCE(?, process_id),
                sequence_no = COALESCE(?, sequence_no),
                machine_id = ?,
                standard_output_per_hour = ?,
                setup_minutes = COALESCE(?, setup_minutes),
                mandatory = COALESCE(?, mandatory),
                remarks = ?
            WHERE id = ?
        `, [
            process_id || null,
            sequence_no || null,
            machine_id || null,
            standard_output_per_hour || null,
            setup_minutes !== undefined ? setup_minutes : null,
            mandatory !== undefined ? (mandatory ? 1 : 0) : null,
            remarks || null,
            id
        ]);

        res.json({
            success: true,
            message: "Routing step updated successfully"
        });
    } catch (error) {
        console.error("Update routing error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update routing step",
            error: error.message
        });
    }
};

// REORDER ROUTING STEPS
const reorderProductRouting = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { productId } = req.params;
        const { orderedIds } = req.body;

        if (!Array.isArray(orderedIds)) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "orderedIds must be an array" });
        }

        for (let i = 0; i < orderedIds.length; i++) {
            await connection.query(
                `UPDATE product_processes SET sequence_no = ? WHERE id = ? AND product_id = ?`,
                [i + 1, orderedIds[i], productId]
            );
        }

        await connection.commit();
        res.json({
            success: true,
            message: "Routing steps reordered successfully"
        });
    } catch (error) {
        await connection.rollback();
        console.error("Reorder routing error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to reorder routing steps",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

// CLONE ROUTING FROM ONE PRODUCT TO ANOTHER
const cloneProductRouting = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { sourceProductId, targetProductId } = req.body;

        if (!sourceProductId || !targetProductId) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Source and target product IDs are required" });
        }

        const [sourceRows] = await connection.query(
            `SELECT * FROM product_processes WHERE product_id = ? ORDER BY sequence_no ASC`,
            [sourceProductId]
        );

        if (sourceRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: "No routing found on source product" });
        }

        // Delete any existing steps on target
        await connection.query(`DELETE FROM product_processes WHERE product_id = ?`, [targetProductId]);

        for (const row of sourceRows) {
            await connection.query(`
                INSERT INTO product_processes (
                    product_id, process_id, sequence_no, machine_id,
                    standard_output_per_hour, setup_minutes, mandatory, remarks
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                targetProductId, row.process_id, row.sequence_no, row.machine_id,
                row.standard_output_per_hour, row.setup_minutes, row.mandatory, row.remarks
            ]);
        }

        await connection.commit();
        res.json({
            success: true,
            message: `Successfully copied ${sourceRows.length} process steps to target product`
        });
    } catch (error) {
        await connection.rollback();
        console.error("Clone routing error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to clone routing",
            error: error.message
        });
    } finally {
        connection.release();
    }
};

module.exports = {
    getProductRouting,
    createProductRouting,
    updateProductRouting,
    reorderProductRouting,
    cloneProductRouting,
    deleteProductRouting,
    getRoutingOptions
};