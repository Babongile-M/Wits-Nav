lucide.createIcons();
  
// RUNNING EXCLUSIVELY ON LIVE PRODUCTION SERVER HOSTED ON Railway.app
const SERVER_URL = "https://wits-nav-production.up.railway.app";
// Check if connection is to the correct place
// console.log(`Wits Nav initialized. Connected to production cluster at: ${SERVER_URL}`);

// Global Google Map Instance Handles
let map;
let userMarker = null;
let watchId = null;
let activeDestination = null; // Tracks current route target dynamically
let activeRoutePolyline = null; // Global hnadle for drawn route map line

let categoryMarkers = [];
let activeMapCategory = null;
let categoryRequestController = null;
let categoryInfoWindow = null;

const searchInput = document.getElementById("search-input");
const filterPanel = document.getElementById("filter-panel");

const destinationTitle = document.getElementById("destination-title");
const destinationCategory = document.getElementById("destination-category");
const mapDestinationTitle = document.getElementById("map-destination-title");
const mapDestinationMeta = document.getElementById("map-destination-meta");
const walkTime = document.getElementById("walk-time");
const walkDistance = document.getElementById("walk-distance");
const etaText = document.getElementById("eta-text");
const routeLabel = document.getElementById("route-label");
const navButtonText = document.getElementById("nav-btn-text");
const liveStepCard = document.getElementById("live-step-card");
const stepInstructionText = document.getElementById("step-instruction-text");
const mapDistancePill = document.getElementById("map-distance-pill");
const stepsPanel = document.getElementById("navigation-steps-panel");

// Tab Screens
const homeScreen = document.getElementById("home-screen");
const abbrevScreen = document.getElementById("abbrev-screen");
const emergencyScreen = document.getElementById("emergency-screen");

// Bottom Nav Buttons
const navHomeBtn = document.getElementById("nav-home-btn");
const navSearchBtn = document.getElementById("nav-search-btn");
const navAbbrevBtn = document.getElementById("nav-abbrev-btn");
const navEmergencyBtn = document.getElementById("nav-emergency-btn");

// Sidebar Nav Buttons
const sidebarHomeBtn = document.getElementById("sidebar-home-btn");
const sidebarSearchBtn = document.getElementById("sidebar-search-btn");
const sidebarAbbrevBtn = document.getElementById("sidebar-abbrev-btn");
const sidebarEmergencyBtn = document.getElementById("sidebar-emergency-btn");

// Direction Instructions Cacellation Button
const cancelNavBtn = document.getElementById("cancel-navigation-btn");

// Emergency Tab Filter Buttons & Cards
const filterMedicalBtn = document.getElementById("filter-medical-btn");
const filterSecurityBtn = document.getElementById("filter-security-btn");
const filterContactsBtn = document.getElementById("filter-contacts-btn");

const medicalCards = document.querySelectorAll('div[data-type="medical"]');
const securityCards = document.querySelectorAll('div[data-type="security"]');
const contactsSidebarPanel = document.getElementById("emergency-contacts-sidebar");

const abbrevSearch = document.getElementById("abbrev-search");

// Automatically fired on layout initialization by the Google scripts callback link
window.initMap = function initMap() {
    // Default coordinate viewport centering securely over Wits East Campus grounds        
    const witsCenterPoint = { lat: -26.1906, lng: 28.0286 };

    map = new google.maps.Map(document.getElementById("google-campus-map"), {
    zoom: 16,
    center: witsCenterPoint,
    gestureHandling: "greedy", // Disables "Use ctrl + scroll to zoom"
    disableDefaultUI: true, // Hides native commercial junk maps UI
    clickableIcons: false,
    });

    // Start live tracking as soon as map loads
    trackUserLocation();
    
    console.log("Google Maps loaded successfully.");
}

// Converts the encoded polyline returned by the Railway backend into
// coordinates that Google Maps can draw on the live map.
// Renders OSRM path coordinates directly on the Google Map using a Polyline
function renderBackendPolyline(pathCoordinates) {
    if (!pathCoordinates || pathCoordinates.length === 0) return;
    if (!window.google || !google.maps || !map) return;

    // Clear any existing polyline line
    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(null);
    }

    // Create new Polyline using OSRM [{lat, lng}] array directly
    activeRoutePolyline = new google.maps.Polyline({
        path: pathCoordinates,
        geodesic: true,
        strokeColor: "#ffb81c", // Official Wits Gold branding accent
        strokeOpacity: 0.9,
        strokeWeight: 5
    });

    activeRoutePolyline.setMap(map);

    // Auto-center and zoom map bounds to fit the route
    const bounds = new google.maps.LatLngBounds();
    pathCoordinates.forEach(coord => bounds.extend(coord));
    map.fitBounds(bounds);
}

// Tracks user's live location
function trackUserLocation() {
    // Check if the browser supports Geolocation
    if (!navigator.geolocation) {
        console.warn("Geolocation is not supported by your browser.");
        return;
    }

    // Watch position continuously as the user walks
    watchId = navigator.geolocation.watchPosition(
    (position) => {
        const userPos = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };

        // Create marker if it doesn't exist yet
        if (!userMarker) {
            userMarker = new google.maps.Marker({
                position: userPos,
                map: map,
                title: "Your Location",
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 8,
                    fillColor: "#4285F4", // Google Blue dot Marker
                    fillOpacity: 1,
                    strokeColor: "#FFFFFF",
                    strokeWeight: 2
                }
            });
        } 

        // Always move the marker when a newer GPS reading arrives.
        userMarker.setPosition(userPos);

        // Advance the instruction when the next point is reached.
        updateStepFromGPS(position);

        // Center the map view to the user's live location before any destination is searched for
        if (!activeDestination && !activeMapCategory) {
            map.setCenter(userPos);
        }
    },
    (error) => {
        console.warn("Location access denied or unavailable:", error.message);
    },
    {
        enableHighAccuracy: true, // Use GPS tracking
        maximumAge: 0,        // Do not use old cache locations
        timeout: 10000
    }
    );
}

function updateDestination(searchInputString) {
    if (!searchInputString) return;

    if (!userMarker || !userMarker.getPosition()) {
        alert("Location access required. Please enable location permissions to navigate.");
        return;
    }

    // Set global target text to engage continuous re-routing block inside watchPosition
    activeDestination = searchInputString.trim();

    const lat = userMarker.getPosition().lat();
    const lng = userMarker.getPosition().lng();

    // Trigger the initial calculation right away
    fetchLiveRoute(lat, lng, activeDestination);
}

function setInstructionsCardMode(isError, heading = "Search message") {
    document.getElementById("navigation-card-icon").classList.toggle("hidden", isError);

    document.getElementById("search-card-icon").classList.toggle("hidden", !isError);

    document.getElementById("instructions-panel-heading").textContent = isError ? "Search result" : "Route Progress";

    document.getElementById("instructions-card-heading").textContent = isError ? heading : "Next step";
}

// Dedicated function handling API calls and map line drawing
let routeRequestController = null;

async function fetchLiveRoute(lat, lng, destination) {
    // Prevent old route instructions from continuing while the new route loads
    clearCategoryMarkers();
    resetStepNavigation();

    if (stepsPanel) stepsPanel.classList.add("hidden");

    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(null);
        activeRoutePolyline = null;
    }

    // Append coordinates as query parameters to allow your Express app to parse them properly
    let fetchUrl = `${SERVER_URL}/buildings?to=${encodeURIComponent(destination)}&userLat=${lat}&userLng=${lng}`;

    if (routeRequestController) routeRequestController.abort();
        const controller = new AbortController();
        routeRequestController = controller;
        const timeoutId = setTimeout(() => {controller.abort();}, 15000);

    if (navButtonText) navButtonText.textContent = "Calculating route...";
    if (routeLabel) routeLabel.textContent = "Calculating...";

    try {
        const response = await fetch(fetchUrl, {
            signal: controller.signal,
            headers: { "Accept": "application/json" }
        });
        const serverData = await response.json().catch(() => ({}));
        // Ignore a response if the user has cleared or replaced this request.
        if (routeRequestController !== controller) return;

        if (controller.signal.aborted) {
            throw new Error("The route request timed out. Please try again.");
        }

        if (!response.ok) {
            const error = new Error(
                serverData.error || "Unable to find a route. Please try again."
            );

            error.code = serverData.code;
            throw error;
        }

        if (!Array.isArray(serverData.pathCoordinates) || serverData.pathCoordinates.length < 2) {
            throw new Error("The navigation server returned an incomplete route.");
        }

        // Update Text panels UI 
        if (destinationTitle) destinationTitle.textContent = serverData.title;
        if (destinationCategory) destinationCategory.textContent = "Live Tracked Campus Venue";
        if (walkTime) walkTime.textContent = serverData.duration;
        if (walkDistance) walkDistance.textContent = serverData.distance;

        // Update floating map badges UI
        if (etaText) etaText.textContent = serverData.duration;
        if (mapDistancePill) mapDistancePill.textContent = serverData.distance;
        if (mapDestinationTitle) mapDestinationTitle.textContent = serverData.title;
        if (mapDestinationMeta) mapDestinationMeta.textContent = "Walking route";
        if (routeLabel) routeLabel.textContent = "Walking route";
        if (navButtonText) navButtonText.textContent = "Navigation active";

        // Unhide step container instruction blocks
        startStepNavigation(serverData.navigationSteps);

        // Restore the normal heading and navigation icon.
        setInstructionsCardMode(false);

        if (stepsPanel) stepsPanel.classList.remove("hidden");

        // Draw vector polyline on the live map canvas
        if (serverData.pathCoordinates) {
            renderBackendPolyline(serverData.pathCoordinates);
        }
    } 
    catch (err) {
        // Ignore requests that were cleared or replaced.
        if (routeRequestController !== controller) return;

        resetStepNavigation();
        activeDestination = null;

        if (activeRoutePolyline) {
            activeRoutePolyline.setMap(null);
            activeRoutePolyline = null;
        }

        const notFound = err.code === "LOCATION_NOT_FOUND";
        const timedOut = controller.signal.aborted;

        let heading;
        let message;

        if (notFound) {
            heading = "Location not found";
            message =
                "We couldn't find that location.\n" +
                "Try WSS, SMH, FNB, CM, CB, Matrix or Old Mutual.";
        } 
        else if (timedOut) {
            heading = "Taking too long";
            message = "The route request took too long. Please try searching again.";
        }
        
        else if (err instanceof TypeError) {
            heading = "Connection problem";
            message = "We couldn't reach the navigation server. Check your connection and try again.";
        } 
        
        else {
            heading = "Route unavailable";
            message = err.message || "Please try searching again.";
        }

        setInstructionsCardMode(true, heading);

        stepInstructionText.style.whiteSpace = "pre-line";
        stepInstructionText.textContent = message;
        stepsPanel.classList.remove("hidden");

        if (routeLabel) routeLabel.textContent = "No active route";
        if (navButtonText) navButtonText.textContent = "Search again";
        if (destinationTitle) destinationTitle.textContent = "No destination selected";
        if (destinationCategory) destinationCategory.textContent = "Search for a campus location";
        if (mapDestinationTitle) mapDestinationTitle.textContent = "No destination selected";
        if (mapDestinationMeta) mapDestinationMeta.textContent = "";
        if (walkTime) walkTime.textContent = "—";
        if (walkDistance) walkDistance.textContent = "—";
        if (etaText) etaText.textContent = "—";
        if (mapDistancePill) mapDistancePill.textContent = "—";

        console.error("Route request failed:", err);
    }
    finally {
        clearTimeout(timeoutId);
    }
}

let navigationSteps = [];
let currentStepIndex = 0;
let nearbyReadings = 0;
let lastStepReadingTime = 0;
let navigationFinished = false;

// Starting values for testing on campus.
const STEP_RADIUS_METRES = 12;
const MAX_GPS_ERROR_METRES = 20;
const REQUIRED_NEARBY_READINGS = 2;

function distanceInMetres(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const earthRadius = 6371000;

    const latitudeDifference = radians(b.lat - a.lat);
    const longitudeDifference = radians(b.lng - a.lng);

    const h =
        Math.sin(latitudeDifference / 2) ** 2 +
        Math.cos(radians(a.lat)) *
        Math.cos(radians(b.lat)) *
        Math.sin(longitudeDifference / 2) ** 2;

    return 2 * earthRadius * Math.asin(
        Math.sqrt(Math.min(1, Math.max(0, h)))
    );
}

function showCurrentStep(note = "") {
    if (!stepInstructionText) return;

    const step = navigationSteps[currentStepIndex];

    if (!step) {
        stepInstructionText.textContent = "";
        return;
    }

    const heading = navigationFinished
        ? "Arrived"
        : `Step ${currentStepIndex + 1} of ${navigationSteps.length}`;

    stepInstructionText.style.whiteSpace = "pre-line";

    stepInstructionText.textContent =
        `${heading}\n${step.instruction}` +
        (note ? `\n${note}` : "");
}

function resetStepNavigation() {
    navigationSteps = [];
    currentStepIndex = 0;
    nearbyReadings = 0;
    lastStepReadingTime = 0;
    navigationFinished = false;

    if (stepInstructionText) {
        stepInstructionText.textContent = "";
    }
}

function startStepNavigation(steps) {
    resetStepNavigation();

    const validSteps = Array.isArray(steps) && steps.length > 0 && steps.every(step =>
            typeof step.instruction === "string" &&
            Number.isFinite(step.target?.lat) &&
            Number.isFinite(step.target?.lng)
        );

    if (!validSteps) {
        throw new Error(
            "Step coordinates are missing. Deploy the updated backend."
        );
    }

    navigationSteps = steps;
    showCurrentStep();
}

function updateStepFromGPS(position) {
    if (!navigationSteps.length || navigationFinished) return;

    const timestamp = position.timestamp;
    const accuracy = position.coords.accuracy;

    // Ignore old or repeated GPS readings.
    if (
        !Number.isFinite(timestamp) ||
        timestamp <= lastStepReadingTime ||
        Date.now() - timestamp > 15000
    ) {
        return;
    }

    lastStepReadingTime = timestamp;

    // Do not advance instructions when GPS is too uncertain.
    if (
        !Number.isFinite(accuracy) ||
        accuracy > MAX_GPS_ERROR_METRES
    ) {
        nearbyReadings = 0;

        showCurrentStep(
            "GPS accuracy is low. Waiting for a clearer location."
        );

        return;
    }

    const userPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
    };

    const step = navigationSteps[currentStepIndex];
    const distance = distanceInMetres(userPosition, step.target);

    if (distance > STEP_RADIUS_METRES) {
        nearbyReadings = 0;
        showCurrentStep();
        return;
    }

    nearbyReadings++;

    if (nearbyReadings < REQUIRED_NEARBY_READINGS) return;

    nearbyReadings = 0;

    if (currentStepIndex < navigationSteps.length - 1) {
        currentStepIndex++;
    }

    const newStep = navigationSteps[currentStepIndex];

    if (
        newStep.isArrival ||
        currentStepIndex === navigationSteps.length - 1
    ) {
        navigationFinished = true;
    }

    showCurrentStep();
}

const locationSuggestions = document.getElementById("location-suggestions");

let searchableLocations = [];

function normaliseSearch(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function updateLocationSuggestions() {
    const query = normaliseSearch(searchInput.value);

    locationSuggestions.replaceChildren();

    if (!query) return;

    // Hide suggestions when the input contains a complete location name.
    // Selecting a suggestion fills the input with this name.
    const completeLocationSelected = searchableLocations.some(
        location => normaliseSearch(location.name) === query
    );

    if (completeLocationSelected) return;

    const matches = searchableLocations.map(location => {
        const names = [
            location.name,
            location.id,
            ...location.aliases
        ].map(normaliseSearch);

        // Show exact matches first, then names starting
        // with the query, then other partial matches.
        let score = 0;

        if (names.some(name => name === query)) {
            score = 3;
        } 

        else if (names.some(name => name.startsWith(query))) {
            score = 2;
        } 

        else if (names.some(name => name.includes(query))) {
            score = 1;
        }

        return { location, score };
    }).filter(match => match.score > 0).sort((a, b) =>
            b.score - a.score ||
            a.location.name.localeCompare(b.location.name)
        ).slice(0, 8);

    for (const { location } of matches) {
        const option = document.createElement("option");

        option.value = location.name;

        // Include matching aliases for native browser filtering.
        option.label = [
            location.id,
            ...location.aliases
        ].join(" • ");

        locationSuggestions.appendChild(option);
    }
}

searchInput.addEventListener("input", updateLocationSuggestions);

async function loadLocationSuggestions() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(`${SERVER_URL}/locations`, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error("Unable to load location suggestions.");
        }

        const locations = await response.json();

        if (!Array.isArray(locations)) {
            throw new Error("Invalid location list.");
        }

        searchableLocations = locations.filter(location =>
            location &&
            typeof location.name === "string"
        ).map(location => ({
                id: location.id || "",
                name: location.name,
                aliases: Array.isArray(location.aliases)
                    ? location.aliases
                    : []
            })
        );

        updateLocationSuggestions();
    } 
    
    catch (error) {
        // Searching still works if suggestions cannot load.
        console.warn("Location suggestions unavailable:", error.message);
    } 
    
    finally {
        clearTimeout(timeoutId);
    }
}

loadLocationSuggestions();

function clearCategoryMarkers() {
    if (categoryRequestController) {
        categoryRequestController.abort();
        categoryRequestController = null;
    }

    categoryMarkers.forEach(marker => marker.setMap(null));
    categoryMarkers = [];

    if (categoryInfoWindow) {
        categoryInfoWindow.close();
    }

    activeMapCategory = null;
}

function showCategoryMessage(message) {
    setInstructionsCardMode(true, "Map locations");

    document.getElementById("instructions-panel-heading").textContent =
        "Map locations";

    stepInstructionText.textContent = message;
    stepsPanel.classList.remove("hidden");
}

async function showLocationCategory(category, title) {
    if (!map || !window.google?.maps) {
        showCategoryMessage("The map is still loading. Please try again.");
        return;
    }

    clearCategoryMarkers();

    // Stop any route request so it cannot draw a route afterwards.
    if (routeRequestController) {
        routeRequestController.abort();
        routeRequestController = null;
    }

    activeDestination = null;
    resetStepNavigation();

    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(null);
        activeRoutePolyline = null;
    }

    activeMapCategory = category;

    searchInput.value = "";
    searchInput.blur();
    document.getElementById("location-suggestions")?.replaceChildren();

    destinationTitle.textContent = title;
    destinationCategory.textContent = "Saved campus locations";

    if (walkTime) walkTime.textContent = "—";
    if (walkDistance) walkDistance.textContent = "—";
    if (etaText) etaText.textContent = "—";
    if (mapDistancePill) mapDistancePill.textContent = "—";
    if (routeLabel) routeLabel.textContent = title;

    showCategoryMessage(`Loading ${title.toLowerCase()}...`);

    const controller = new AbortController();
    categoryRequestController = controller;

    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const response = await fetch(`${SERVER_URL}/locations`, {
            signal: controller.signal,
            headers: { Accept: "application/json" }
        });

        if (!response.ok) {
            throw new Error("Locations could not be loaded.");
        }

        const locations = await response.json();

        // Ignore an old request after another category or search is selected.
        if (categoryRequestController !== controller) return;

        if (!Array.isArray(locations)) {
            throw new Error("Invalid locations response.");
        }

        const matches = locations.filter(location =>
            location.category === category &&
            typeof location.name === "string" &&
            Number.isFinite(location.lat) &&
            Number.isFinite(location.lng) &&
            Math.abs(location.lat) <= 90 &&
            Math.abs(location.lng) <= 180
        );

        if (matches.length === 0) {
            showCategoryMessage(
                `No ${title.toLowerCase()} have been saved with coordinates yet.`
            );
            return;
        }

        const bounds = new google.maps.LatLngBounds();

        if (!categoryInfoWindow) {
            categoryInfoWindow = new google.maps.InfoWindow();
        }

        matches.forEach(location => {
            const position = {
                lat: location.lat,
                lng: location.lng
            };

            const marker = new google.maps.Marker({
                map,
                position,
                title: location.name,

                // Display the venue name beneath its marker.
                label: {
                    text: location.name,
                    color: "#002855",
                    fontSize: "12px",
                    fontWeight: "700",
                    className: "venue-marker-label"
                },

                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 8,
                    fillColor: category === "residence"
                        ? "#ffb81c"
                        : "#059669",
                    fillOpacity: 1,
                    strokeColor: "#ffffff",
                    strokeWeight: 2,
                    labelOrigin: new google.maps.Point(0, 3)
                }
            });

            // Tapping a marker shows its name; it does not start a route.
            marker.addListener("click", () => {
                const content = document.createElement("div");
                content.textContent = location.name;
                content.style.fontWeight = "700";
                content.style.color = "#002855";

                categoryInfoWindow.setContent(content);
                categoryInfoWindow.open({
                    map,
                    anchor: marker
                });
            });

            categoryMarkers.push(marker);
            bounds.extend(position);
        });

        if (matches.length === 1) {
            map.setCenter({
                lat: matches[0].lat,
                lng: matches[0].lng
            });
            map.setZoom(17);
        } else {
            map.fitBounds(bounds, 80);
        }

        destinationCategory.textContent =
            `${matches.length} saved locations`;

        showCategoryMessage(
            `Showing ${matches.length} ${title.toLowerCase()}. ` +
            "Tap a marker to see its name."
        );
    } catch (error) {
        if (categoryRequestController !== controller) return;

        clearCategoryMarkers();

        showCategoryMessage(
            error.name === "AbortError"
                ? "Loading locations took too long. Please try again."
                : "Could not load the locations. Please try again."
        );
    } finally {
        clearTimeout(timeoutId);

        if (categoryRequestController === controller) {
            categoryRequestController = null;
        }
    }
}

document.querySelectorAll(".quick-access").forEach(button => {
    button.addEventListener("click", () => {
        const place = button.dataset.place;

        if (place === "Residences") {
            showLocationCategory("residence", "Residences");
            return;
        }

        if (place === "Campus Entrances") {
            showLocationCategory("entrance", "Campus Entrances");
            return;
        }

        if (place === "Emergency Services") {
            const emergencyButton =
                document.getElementById("nav-emergency-btn") ||
                document.getElementById("sidebar-emergency-btn");

            emergencyButton?.click();
        }
    });
});

searchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;

    event.preventDefault();

    const value = searchInput.value.trim();
    if (!value) return;

    searchInput.blur(); // Close the mobile keyboard.
    updateDestination(value);
});

// Recenter button is optional in the current UI.
// If it is added later, it will safely control the Google Map instance.
const recenterButton = document.getElementById("recenter-button");

if (recenterButton) {
    recenterButton.addEventListener("click", () => {
    if (!map) return;

    map.setCenter({ lat: -26.1906, lng: 28.0286 });
    map.setZoom(16);
    });
}

const gpsPill = document.getElementById("gps-pill");
const gpsText = document.getElementById("gps-text");

// Tab Switching Logic
function setActiveTab(activeButton) {
    // Save the current tab in local browser storage to avoid going back to home tab on refresh
    // This can still go back to home if no session was stored
    try {
        sessionStorage.setItem("witsNavActiveTab", activeButton);
    } catch (error) {
        // Tab switching still works if browser storage is unavailable.
    }
    // Setup mobile nav match list
    const mobileTabs = [navHomeBtn, navSearchBtn, navAbbrevBtn, navEmergencyBtn];
    const targetMobile = document.getElementById(`nav-${activeButton}-btn`);
    
    mobileTabs.forEach(tab => {
        if (tab && tab === targetMobile) {
            tab.classList.add("text-wits-gold", "font-bold");
            tab.classList.remove("text-slate-400", "hover:text-wits-900");
        } 
        else if (tab) {
            tab.classList.remove("text-wits-gold", "font-bold");
            tab.classList.add("text-slate-400", "hover:text-wits-900");
        }
    });

    // Setup desktop sidebar match list
    const sidebarTabs = [sidebarHomeBtn, sidebarSearchBtn, sidebarAbbrevBtn, sidebarEmergencyBtn];
    const targetSidebar = document.getElementById(`sidebar-${activeButton}-btn`);
    
    sidebarTabs.forEach(btn => {
        if (btn && btn === targetSidebar) {
            btn.className = "w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-wits-gold text-wits-900 font-bold text-sm transition";
        } 
        else if (btn) {
            btn.className = "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-blue-100 hover:bg-white/10 font-medium text-sm transition";
        }
    });
}

// Restores stored Tab, if any
function restoreActiveTab() {
    let savedTab = "home";

    try {
        savedTab =
            sessionStorage.getItem("witsNavActiveTab") || "home";
    } catch (error) {
        // Use Home tab if browser storage is unavailable.
    }

    const tabButtons = new Map([
        ["home", navHomeBtn || sidebarHomeBtn],
        ["abbrev", navAbbrevBtn || sidebarAbbrevBtn],
        ["emergency", navEmergencyBtn || sidebarEmergencyBtn]
    ]);

    const button = tabButtons.get(savedTab) || tabButtons.get("home");

    // Reuse the existing handler to show the screen
    // and update both navigation menus.
    if (button) button.click();
}

if (navHomeBtn) navHomeBtn.addEventListener("click", () => { 
    setActiveTab("home"); 
    abbrevScreen.classList.add("hidden"); 
    emergencyScreen.classList.add("hidden");
    homeScreen.classList.remove("hidden"); 
});

if (sidebarHomeBtn) sidebarHomeBtn.addEventListener("click", () => { 
    setActiveTab("home"); 
    abbrevScreen.classList.add("hidden"); 
    emergencyScreen.classList.add("hidden");
    homeScreen.classList.remove("hidden"); 
});

if (navAbbrevBtn) navAbbrevBtn.addEventListener("click", () => { 
    setActiveTab("abbrev"); 
    homeScreen.classList.add("hidden"); 
    emergencyScreen.classList.add("hidden");
    abbrevScreen.classList.remove("hidden"); 
});

if (sidebarAbbrevBtn) sidebarAbbrevBtn.addEventListener("click", () => { 
    setActiveTab("abbrev"); 
    homeScreen.classList.add("hidden"); 
    emergencyScreen.classList.add("hidden");
    abbrevScreen.classList.remove("hidden"); 
});

if (navEmergencyBtn) {
navEmergencyBtn.addEventListener("click", () => { 
    setActiveTab("emergency"); 
    homeScreen.classList.add("hidden"); 
    abbrevScreen.classList.add("hidden"); 
    emergencyScreen.classList.remove("hidden");
    runEmergencyFilter("medical"); 
    });
}

if (sidebarEmergencyBtn) {
    sidebarEmergencyBtn.addEventListener("click", () => { 
    setActiveTab("emergency"); 
    homeScreen.classList.add("hidden"); 
    abbrevScreen.classList.add("hidden"); 
    emergencyScreen.classList.remove("hidden");
    });
}

if (cancelNavBtn) {
    cancelNavBtn.addEventListener("click", () => {
        clearCategoryMarkers();
        activeDestination = null;

        if (destinationTitle) {
            destinationTitle.textContent = "No destination selected";
        }

        if (destinationCategory) {
            destinationCategory.textContent = "Search or choose Quick Access";
        }

        if (routeRequestController) {
            routeRequestController.abort();
            routeRequestController = null;
        }

        resetStepNavigation();

        // Remove the route line from the map.
        if (activeRoutePolyline) {
            activeRoutePolyline.setMap(null);
            activeRoutePolyline = null;
        }

        if (routeLabel) routeLabel.textContent = "No active route";
        if (walkTime) walkTime.textContent = "—";
        if (walkDistance) walkDistance.textContent = "—";
        if (etaText) etaText.textContent = "—";
        if (mapDistancePill) mapDistancePill.textContent = "—";

        if (stepsPanel) stepsPanel.classList.add("hidden");
        searchInput.value = "";

        if (userMarker) {
            map.setCenter(userMarker.getPosition());
            map.setZoom(16); 
        }
    });
}

function runEmergencyFilter(selectedType) {
    const filterButtons = [filterMedicalBtn, filterSecurityBtn, filterContactsBtn];

    // Update chip button styles (active vs inactive states)
    filterButtons.forEach(btn => {
    if (!btn) return;
    
    // Keep 'lg:hidden' appended to the contacts chip so it stays invisible on desktop
    const desktopHideClass = (btn === filterContactsBtn) ? " lg:hidden" : "";

    if ((selectedType === "medical" && btn === filterMedicalBtn) ||
        (selectedType === "security" && btn === filterSecurityBtn) ||
        (selectedType === "contacts" && btn === filterContactsBtn)) {
        btn.className = "px-4 py-1.5 text-xs font-bold bg-wits-900 text-white rounded-full whitespace-nowrap transition" + desktopHideClass;
    } 
    else {
        btn.className = "px-4 py-1.5 text-xs font-medium bg-white text-slate-600 border border-slate-200 rounded-full whitespace-nowrap hover:bg-slate-50 transition" + desktopHideClass;
    }
    });

    // 2. Apply Visibility Filtering
    // Check if user is currently on desktop layout viewport
    const isDesktop = window.innerWidth >= 1024;

    if (isDesktop) {
    // Desktop Rules: Contacts sidebar is ALWAYS visible. Only toggle content cards.
    contactsSidebarPanel.className = "hidden lg:block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle sticky top-24";
    
    medicalCards.forEach(card => card.classList.toggle("hidden", selectedType !== "medical"));
    securityCards.forEach(card => card.classList.toggle("hidden", selectedType !== "security"));
    } 
    else {
    // Mobile Rules: Filter everything including the contacts list panel as a card
    if (selectedType === "medical") {
        medicalCards.forEach(card => card.classList.remove("hidden"));
        securityCards.forEach(card => card.classList.add("hidden"));
        contactsSidebarPanel.className = "hidden"; // Hide completely
    } 
    else if (selectedType === "security") {
        medicalCards.forEach(card => card.classList.add("hidden"));
        securityCards.forEach(card => card.classList.remove("hidden"));
        contactsSidebarPanel.className = "hidden"; // Hide completely
    }
    else if (selectedType === "contacts") {
        medicalCards.forEach(card => card.classList.add("hidden"));
        securityCards.forEach(card => card.classList.add("hidden"));
        // Make the aside style look like a normal stacked element card block on mobile
        if (contactsSidebarPanel) {
        contactsSidebarPanel.className = "block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle -mt-6";
        }        
    }
    }
}

// Attach the click listeners
if (filterMedicalBtn) filterMedicalBtn.addEventListener("click", () => runEmergencyFilter("medical"));
if (filterSecurityBtn) filterSecurityBtn.addEventListener("click", () => runEmergencyFilter("security"));
if (filterContactsBtn) filterContactsBtn.addEventListener("click", () => runEmergencyFilter("contacts"));

// Also reset the view states if the screen size changes dynamically live
window.addEventListener("resize", () => {
    // 1. Detect which chip currently carries the active background style color
    const isMedicalActive = filterMedicalBtn && filterMedicalBtn.classList.contains("bg-wits-900");
    const isSecurityActive = filterSecurityBtn && filterSecurityBtn.classList.contains("bg-wits-900");
    const isContactsActive = filterContactsBtn && filterContactsBtn.classList.contains("bg-wits-900");

    // 2. Check the view layout width (1024px matches Tailwind's 'lg:' desktop breakpoint)
    const isDesktop = window.innerWidth >= 1024;

    // 3. Re-run your filter function preserving the active type state parameters
    if (isMedicalActive) {
        runEmergencyFilter("medical");
    } 
    else if (isSecurityActive) {
        runEmergencyFilter("security");
    } 
    else if (isContactsActive) {
        // If the contacts chip was chosen on mobile, but the user scales up to desktop size,
        // default back to medical since the chip itself vanishes on desktops.
        if (isDesktop) {
            runEmergencyFilter("medical");
        } 
        else {
            runEmergencyFilter("contacts");
        }
    }
});


// Abbreviations Tab Card Filter
function filterAbbreviations(query) {
    const sanitizedQuery = query.trim().toLowerCase();
    const cards = document.querySelectorAll('.abbrev-card');
    
    cards.forEach(card => {
        const acronymText = card.querySelector('span') ? card.querySelector('span').textContent.toLowerCase() : '';
        const titleText = card.querySelector('h4') ? card.querySelector('h4').textContent.toLowerCase() : '';
        const descriptionText = card.querySelector('p') ? card.querySelector('p').textContent.toLowerCase() : '';
        
        if (acronymText.includes(sanitizedQuery) || titleText.includes(sanitizedQuery)) {
            card.style.display = "";   
        } 
        else {
            card.style.display = "none";   
        }
    });
}

document.querySelectorAll("[data-route-to]").forEach(button => {
    button.addEventListener("click", () => {
        const destination = button.dataset.routeTo?.trim();

        if (!destination) return;

        // Open Home using its existing tab-switching handler.
        const homeButton = navHomeBtn || sidebarHomeBtn;

        if (homeButton) homeButton.click();

        // Fill the search field and remove previous suggestions.
        searchInput.value = destination;
        locationSuggestions.replaceChildren();

        // Avoid opening the mobile keyboard.
        searchInput.blur();

        // Bring the search area into view.
        searchInput.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        // Automatically request the route.
        updateDestination(destination);
    });
});

// Restore any saved tabs if any, else, go to home as the default
restoreActiveTab();