require("dotenv").config(); // Load the .env file safely to use secret variables
const pack = require("express");
const cors = require("cors"); // ADD CORS MIDDLEWARE (Fixes the "blocked by CORS policy" error sicne we are using a live server not a local one
const axios = require("axios"); // Added to sent HTTP requests to Google

const server = pack();
server.use(cors()); 

// Pull The Google Maps API Key from the .env file
const GOOGLE_KEY = process.env.GOOGLE_DIRECTIONS_API_KEY;

const nodes = require("./nodes.json");
const connections = require("./connections.json");
const directions = require("./directions.json");

// Ensuring that Railway.app uses its custom port dynamically first before defaulting to port 8080 locally
const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`The server is running on port ${PORT}`);
});

server.get("/buildings", async (req, res) => {
    const { from, to } = req.query;

    // Boundary check parameters verification block
    if (!from || !to) {
        return res.status(400).json({ error: "Missing navigation boundaries" });
    }

    // Debugging Check: Verify environment variable exists
    if (!GOOGLE_KEY) {
        console.error("CRITICAL ERROR: GOOGLE_DIRECTIONS_API_KEY is not defined in environment variables!");
        return res.status(500).json({ error: "Server misconfiguration: Missing API Key" });
    }

    // Translates fast acronym keywords straight to official physical addresses
    const witsAcronymsLookup = {
        "wss": "Wits Science Stadium, Braamfontein, Johannesburg",
        "smh": "Solomon Mahlangu House, Wits University, Johannesburg",
        "fnb": "FNB Building, Wits West Campus, Johannesburg",
        "cm": "Chamber of Mines Building, Wits University, Johannesburg",
        "sh": "Senate House, Wits University, Johannesburg",
        "cb": "Central Block, Wits University, Johannesburg",
        "matrix": "The Matrix Student Centre, Wits University, Johannesburg",
        "oldmutual": "Old Mutual Building, Wits University, Johannesburg",

        // Full Names / Common Variants mapped back to precise addresses
        "wits science stadium": "Wits Science Stadium, Braamfontein, Johannesburg",
        "solomon mahlangu house": "Solomon Mahlangu House, Wits University, Johannesburg",
        "fnb building": "FNB Building, Wits West Campus, Johannesburg",
        "chamber of mines": "Chamber of Mines Building, Wits University, Johannesburg",
        "chamber of mines building": "Chamber of Mines Building, Wits University, Johannesburg",
        "senate house": "Senate House, Wits University, Johannesburg",
        "central block": "Central Block, Wits University, Johannesburg",
        "the matrix": "The Matrix Student Centre, Wits University, Johannesburg",
        "old mutual": "Old Mutual Building, Wits University, Johannesburg",
        "old mutual building": "Old Mutual Building, Wits University, Johannesburg"
    };

    // Helper function to resolve term whether it's an acronym or full name
    function resolveCampusAddress(inputTerm) {
        if (!inputTerm) return "";
        
        // Strip spaces, punctuation, and convert to lowercase for key comparison
        const cleanedTerm = inputTerm.toLowerCase().trim();
        const strippedTerm = cleanedTerm.replace(/[^a-z0-9]/g, "");

        // Check direct key match (e.g. "wss" or "wits science stadium")
        if (campusLocations[cleanedTerm]) {
            return campusLocations[cleanedTerm];
        }

        // Check stripped key match (e.g. "oldmutual" vs "old mutual")
        if (campusLocations[strippedTerm]) {
            return campusLocations[strippedTerm];
        }

        // Fallback: If user passes a custom text string, append campus bounds safely for Google Maps geocoding
        return `${inputTerm}, Wits University, Johannesburg`;
    }

    // Clean text strings and map matching address bounds, fallback to search text if not in dictionary
    const originAddress = witsAcronymsLookup[from.toLowerCase().trim()] || `${from}, Wits University, Johannesburg`;
    const destinationAddress = witsAcronymsLookup[to.toLowerCase().trim()] || `${to}, Wits University, Johannesburg`;

    try {
        // Query Google's global Directions routing engine directly from your server side
        const googleUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(originAddress)}&destination=${encodeURIComponent(destinationAddress)}&mode=walking&key=${GOOGLE_KEY}`;
        const googleResponse = await axios.get(googleUrl);
        const data = googleResponse.data;

        if (data.status !== "OK") {
            return res.status(400).json({ 
                error: `Google API Error: ${data.status}`,
                googleMessage: data.error_message || "Route could not be calculated."
            });
        }

        const leg = data.routes[0].legs[0];
        
        // CRITICAL FOR DYNAMIC FRONTEND RENDERING: Extract overview path polyline geometry tokens.
        // This compressed vector path string lets the frontend render smooth path overlays onto the live map frame.
        const overviewPolyline = data.routes[0].overview_polyline.points;

        // Concatenate individual step instructions together cleanly into a single structured list array
        const customInstructionsList = leg.steps.map((step, index) => {
            // Strip out native browser HTML styling annotations (like <b>Head north</b> -> Head north)
            return `${index + 1}. ${step.instructions.replace(/<\/?[^>]+(>|\$)/g, "")}`;
        });

        // Respond back to frontend with a neat, lightweight data delivery payload package
        res.json({
            title: to.toUpperCase(),
            duration: leg.duration.text,
            distance: leg.distance.text,
            directions: customInstructionsList, // Sent as an array list of dynamic instructions steps
            polyline: overviewPolyline 
        });

    } catch (error) {
        // Log detailed error details to Railway logs
        console.error("Backend Server Error Details:", error.response ? error.response.data : error.message);
        // console.error("Backend request validation server fault:", error.message);
        res.status(500).json({ error: "Internal navigation engine communication failure" });
    }
});