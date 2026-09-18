require("dotenv").config(); // Load the .env file safely to use secret variables
const pack = require("express");
const cors = require("cors"); // ADD CORS MIDDLEWARE (Fixes the "blocked by CORS policy" error since we are using a live server not a local one)
const axios = require("axios"); // Added to send HTTP requests to OSRM

const server = pack();
server.use(cors()); 

const nodes = require("./nodes.json");
const connections = require("./connections.json");
const directions = require("./directions.json");

// Ensuring that Railway.app uses its custom port dynamically first before defaulting to port 8080 locally
const PORT = process.env.PORT || 8080;

// Exact Wits Campus coordinates { lat, lng } replacing text street addresses
const witsCoordinates = {
    "wss": { lat: -26.1924, lng: 28.0268 },         // Wits Science Stadium
    "smh": { lat: -26.1929, lng: 28.0306 },         // Solomon Mahlangu House
    "fnb": { lat: -26.1899, lng: 28.0242 },         // FNB Building
    "cm":  { lat: -26.1912, lng: 28.0315 },         // Chamber of Mines Building
    "sh":  { lat: -26.1929, lng: 28.0306 },         // Senate House / SMH
    "cb":  { lat: -26.1918, lng: 28.0300 },         // Central Block
    "matrix": { lat: -26.1908, lng: 28.0285 },     // The Matrix Student Centre
    "oldmutual": { lat: -26.1915, lng: 28.0305 },   // Old Mutual Building

    // Full Names / Common Variants mapped back to coordinates
    "wits science stadium": { lat: -26.1924, lng: 28.0268 },
    "solomon mahlangu house": { lat: -26.1929, lng: 28.0306 },
    "fnb building": { lat: -26.1899, lng: 28.0242 },
    "chamber of mines": { lat: -26.1912, lng: 28.0315 },
    "chamber of mines building": { lat: -26.1912, lng: 28.0315 },
    "senate house": { lat: -26.1929, lng: 28.0306 },
    "central block": { lat: -26.1918, lng: 28.0300 },
    "the matrix": { lat: -26.1908, lng: 28.0285 },
    "old mutual": { lat: -26.1915, lng: 28.0305 },
    "old mutual building": { lat: -26.1915, lng: 28.0305 }
};

server.listen(PORT, "0.0.0.0", () => {
  console.log(`The server is running on port ${PORT}`);
});

server.get("/buildings", async (req, res) => {
    const { from, to, userLat, userLng } = req.query;

    // Must have a destination 'to' parameter
    if (!to) {
        return res.status(400).json({ error: "Missing destination boundary ('to' parameter required)." });
    }

    let startLocation = null;

    // Check if user sent live GPS coordinates
    if (userLat && userLng) {
        const parsedLat = parseFloat(userLat);
        const parsedLng = parseFloat(userLng);

        if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
            startLocation = { lat: parsedLat, lng: parsedLng };
        }
    }

    // If no live GPS coordinates provided, fall back to lookup by 'from' acronym
    if (!startLocation) {
        if (!from) {
            return res.status(400).json({ error: "Missing origin boundary. Provide 'from' or 'userLat' & 'userLng'." });
        }
        const cleanFrom = from.toLowerCase().trim();
        startLocation = witsCoordinates[cleanFrom];
    }

    const cleanTo = to.toLowerCase().trim();
    const endLocation = witsCoordinates[cleanTo];

    if (!startLocation || !endLocation) {
        return res.status(400).json({ error: "One or both campus locations were not found." });
    }

    try {
        // Query OSRM walking engine directly (Format: lng,lat;lng,lat)
        const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${startLocation.lng},${startLocation.lat};${endLocation.lng},${endLocation.lat}?overview=full&steps=true&geometries=geojson`;
        
        const osrmResponse = await axios.get(osrmUrl);
        const data = osrmResponse.data;

        if (!data.routes || data.routes.length === 0) {
            return res.status(400).json({ error: "OSRM Route could not be calculated." });
        }

        const route = data.routes[0];

        // Convert OSRM GeoJSON [lng, lat] coordinate points to Google Maps LatLng [{ lat, lng }]
        const pathCoordinates = route.geometry.coordinates.map(coord => ({
            lat: coord[1],
            lng: coord[0]
        }));

        // Format turn-by-turn instruction steps into readable strings
        const customInstructionsList = route.legs[0].steps.map((step, index) => {
            const streetName = step.name ? ` onto ${step.name}` : "";
            return `${index + 1}. Walk ${Math.round(step.distance)}m (${step.maneuver.type}${streetName})`;
        });

        // Respond back to frontend with payload
        res.json({
            title: to.toUpperCase(),
            duration: `${Math.round(route.duration / 60)} mins`,
            distance: `${Math.round(route.distance)} m`,
            directions: customInstructionsList,
            pathCoordinates: pathCoordinates
        });

    } catch (error) {
        console.error("Backend Server Error Details:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Internal navigation engine communication failure" });
    }
});