require("dotenv").config();

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
}

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const authRoutes = require("./routes/authRoutes");
const botRoutes = require("./routes/botRoutes");
app.use("/", authRoutes);
app.use("/", botRoutes);

app.get("/", (req, res) => {
    res.send("Meet AI Scribe backend running");
});

app.listen(process.env.PORT || 4000, () => {
    console.log("Server running on port 4000");
});