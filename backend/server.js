require("dotenv").config(); // Load the .env file safely to use secret variables
const express = require("express");
const cors = require("cors"); // ADD CORS MIDDLEWARE (Fixes the "blocked by CORS policy" error since we are using a live server not a local one)
const axios = require("axios"); // Added to send HTTP requests to OSRM

const server = express();
// Ensuring that Railway.app uses its custom port dynamically first before defaulting to port 8080 locally
const PORT = process.env.PORT || 8080;

server.use(cors()); 

const nodes = require("./nodes.json"); // Get pre-defined venues and their locations

server.listen(PORT, "0.0.0.0", () => {
  console.log(`The server is running on port ${PORT}`);
});

// Make searches igbore capital letter and extra spaces
function normalise(value) {
    return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

// Build a lookup tbles from nodes.json
const locationLookup = new Map();

for (const node of nodes) {
    const searchNmes = [
        node.id,
        node.name,
        ...(node.aliases || [])
    ];

    for (const name of searchNmes) {
        const key = normalise(name);
        if (!key) continue;

        const existing = locationLookup.get(key);

        if (existing && existing.id !== node.id) {
            throw new Error("Duplicate location alias: ${name}");
        }

        locationLookup.set(key, node);
    }
}

// Find user searched location/venue
function findLocation(value) {
    return locationLookup.get(normalise(value)) || null;
}

function hasCoordinates(location) {
    return Boolean(
        location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lng) &&
        location.lat >= -90 &&
        location.lat <= 90 &&
        location.lng >= -180 &&
        location.lng <= 180
    );
}

server.get("/buildings", async (req, res) => {
    const {from, to, userLat, userLng} = req.query;

    if (!normalise(to)) {
        return res.status(400).json({
            error: "Please enter a destination."
        });
    }

    const endLocation = findLocation(to);

    if (!endLocation) {
        return res.status(404).json({
            error: "Destination not found. Try WSS, SMH, FNB, CM or Matrix."
        });
    }

    if (!hasCoordinates(endLocation)) {
        return res.status(400).json({
            error: `${endLocation.name} is listed, but its coordinates have not been added yet.`
        });
    }

    let startLocation;

    // If either GPS coordinate is supplied, require both to be valid.
    if (userLat !== undefined || userLng !== undefined) {
        const validInput =
            typeof userLat === "string" &&
            typeof userLng === "string" &&
            userLat.trim() !== "" &&
            userLng.trim() !== "";

        if (!validInput) {
            return res.status(400).json({
                error: "Both GPS latitude and longitude are required."
            });
        }

        startLocation = {
            lat: Number(userLat),
            lng: Number(userLng)
        };

        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                error: "Your GPS coordinates are invalid. Please try again."
            });
        }
    } else {
        startLocation = findLocation(from);

        if (!startLocation) {
            return res.status(400).json({
                error: "Provide your live location or a recognised starting building."
            });
        }

        if (!hasCoordinates(startLocation)) {
            return res.status(400).json({
                error: `${startLocation.name} does not have coordinates yet.`
            });
        }
    }

    try {
        // Query OSRM walking engine directly (Format: lng,lat;lng,lat)
        const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${startLocation.lng},${startLocation.lat};${endLocation.lng},${endLocation.lat}?overview=full&steps=true&geometries=geojson`;
        
        const osrmResponse = await axios.get(osrmUrl, {
            timeout: 12000
        });
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
            title: endLocation.name,
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