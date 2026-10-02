const express = require("express");
const {
    getUsers,
    getRoles,
    getEligibleEmployees,
    createUser,
    updateUser,
    resetPassword,
    toggleUserStatus,
    deleteUser
} = require("../controllers/userController");

const router = express.Router();

router.get("/", getUsers);
router.get("/roles", getRoles);
router.get("/eligible-employees", getEligibleEmployees);
router.post("/", createUser);
router.put("/:id", updateUser);
router.put("/:id/reset-password", resetPassword);
router.patch("/:id/status", toggleUserStatus);
router.delete("/:id", deleteUser);

module.exports = router;
