lucide.createIcons();
  
// RUNNING EXCLUSIVELY ON LIVE PRODUCTION SERVER HOSTED ON Railway.app
const SERVER_URL =
    "https://wits-nav-production.up.railway.app";

// Global Google Map Instance Handles
let map;
let userMarker = null;
let watchId = null;
let activeDestination = null;
let activeRoutePolyline = null;

let categoryMarkers = [];
let activeMapCategory = null;
let categoryRequestController = null;
let categoryInfoWindow = null;

const searchInput =
    document.getElementById("search-input");

const filterPanel =
    document.getElementById("filter-panel");

const destinationTitle =
    document.getElementById("destination-title");

const destinationCategory =
    document.getElementById(
        "destination-category"
    );

const mapDestinationTitle =
    document.getElementById(
        "map-destination-title"
    );

const mapDestinationMeta =
    document.getElementById(
        "map-destination-meta"
    );

const walkTime =
    document.getElementById("walk-time");

const walkDistance =
    document.getElementById(
        "walk-distance"
    );

const etaText =
    document.getElementById("eta-text");

const routeLabel =
    document.getElementById(
        "route-label"
    );

const navButtonText =
    document.getElementById(
        "nav-btn-text"
    );

const liveStepCard =
    document.getElementById(
        "live-step-card"
    );

const stepInstructionText =
    document.getElementById(
        "step-instruction-text"
    );

const mapDistancePill =
    document.getElementById(
        "map-distance-pill"
    );

const stepsPanel =
    document.getElementById(
        "navigation-steps-panel"
    );

// Tab Screens
const homeScreen =
    document.getElementById(
        "home-screen"
    );

const abbrevScreen =
    document.getElementById(
        "abbrev-screen"
    );

const emergencyScreen =
    document.getElementById(
        "emergency-screen"
    );

// Bottom Nav Buttons
const navHomeBtn =
    document.getElementById(
        "nav-home-btn"
    );

const navSearchBtn =
    document.getElementById(
        "nav-search-btn"
    );

const navAbbrevBtn =
    document.getElementById(
        "nav-abbrev-btn"
    );

const navEmergencyBtn =
    document.getElementById(
        "nav-emergency-btn"
    );

// Sidebar Nav Buttons
const sidebarHomeBtn =
    document.getElementById(
        "sidebar-home-btn"
    );

const sidebarSearchBtn =
    document.getElementById(
        "sidebar-search-btn"
    );

const sidebarAbbrevBtn =
    document.getElementById(
        "sidebar-abbrev-btn"
    );

const sidebarEmergencyBtn =
    document.getElementById(
        "sidebar-emergency-btn"
    );

// Direction Instructions Cancellation Button
const cancelNavBtn =
    document.getElementById(
        "cancel-navigation-btn"
    );

// Emergency Tab Filter Buttons & Cards
const filterMedicalBtn =
    document.getElementById(
        "filter-medical-btn"
    );

const filterSecurityBtn =
    document.getElementById(
        "filter-security-btn"
    );

const filterContactsBtn =
    document.getElementById(
        "filter-contacts-btn"
    );

const medicalCards =
    document.querySelectorAll(
        'div[data-type="medical"]'
    );

const securityCards =
    document.querySelectorAll(
        'div[data-type="security"]'
    );

const contactsSidebarPanel =
    document.getElementById(
        "emergency-contacts-sidebar"
    );

const abbrevSearch =
    document.getElementById(
        "abbrev-search"
    );

// Automatically fired by the Google Maps
// callback in the existing HTML.
window.initMap = function initMap() {
    const witsCenterPoint = {
        lat: -26.1906,
        lng: 28.0286
    };

    map = new google.maps.Map(
        document.getElementById(
            "google-campus-map"
        ),
        {
            zoom: 16,

            center:
                witsCenterPoint,

            gestureHandling:
                "greedy",

            disableDefaultUI:
                true,

            clickableIcons:
                false
        }
    );

    // Start GPS tracking once map exists.
    trackUserLocation();

    console.log(
        "Google Maps loaded successfully."
    );
};

// Draw the walking route returned by Railway.
function renderBackendPolyline(
    pathCoordinates
) {
    if (
        !Array.isArray(
            pathCoordinates
        ) ||
        pathCoordinates.length === 0
    ) {
        return;
    }

    if (
        !window.google ||
        !google.maps ||
        !map
    ) {
        return;
    }

    // Remove previous route.
    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(
            null
        );
    }

    activeRoutePolyline =
        new google.maps.Polyline({
            path:
                pathCoordinates,

            geodesic: true,

            strokeColor:
                "#ffb81c",

            strokeOpacity:
                0.9,

            strokeWeight:
                5
        });

    activeRoutePolyline.setMap(
        map
    );

    // Zoom to fit full walking route.
    const bounds =
        new google.maps.LatLngBounds();

    pathCoordinates.forEach(
        coordinate => {
            bounds.extend(
                coordinate
            );
        }
    );

    map.fitBounds(bounds);
}

// Tracks user's live location.
function trackUserLocation() {
    if (!navigator.geolocation) {
        console.warn(
            "Geolocation is not supported by your browser."
        );

        return;
    }

    // Avoid accidentally starting multiple GPS watchers.
    if (watchId !== null) {
        navigator.geolocation.clearWatch(
            watchId
        );

        watchId = null;
    }

    watchId =
        navigator.geolocation.watchPosition(
            position => {
                const userPos = {
                    lat:
                        position.coords
                            .latitude,

                    lng:
                        position.coords
                            .longitude
                };

                // Create blue location marker
                // once.
                if (!userMarker) {
                    userMarker =
                        new google.maps.Marker({
                            position:
                                userPos,

                            map,

                            title:
                                "Your Location",

                            icon: {
                                path:
                                    google.maps
                                        .SymbolPath
                                        .CIRCLE,

                                scale: 8,

                                fillColor:
                                    "#4285F4",

                                fillOpacity:
                                    1,

                                strokeColor:
                                    "#FFFFFF",

                                strokeWeight:
                                    2
                            }
                        });
                }

                // Move marker with latest GPS.
                userMarker.setPosition(
                    userPos
                );

                // Check whether user reached
                // the end of the current step.
                updateStepFromGPS(
                    position
                );

                // Before navigation begins,
                // keep map centred on user.
                if (
                    !activeDestination &&
                    !activeMapCategory
                ) {
                    map.setCenter(
                        userPos
                    );
                }
            },

            error => {
                console.warn(
                    "Location access denied or unavailable:",
                    error.message
                );
            },

            {
                enableHighAccuracy:
                    true,

                maximumAge: 0,

                timeout: 10000
            }
        );
}

function updateDestination(
    searchInputString
) {
    if (!searchInputString) {
        return;
    }

    if (
        !userMarker ||
        !userMarker.getPosition()
    ) {
        alert(
            "Location access required. Please enable location permissions to navigate."
        );

        return;
    }

    // Save current destination while
    // navigation is active.
    activeDestination =
        searchInputString.trim();

    const lat =
        userMarker
            .getPosition()
            .lat();

    const lng =
        userMarker
            .getPosition()
            .lng();

    // Calculate route from current GPS
    // location.
    fetchLiveRoute(
        lat,
        lng,
        activeDestination
    );
}

function setInstructionsCardMode(
    isError,
    heading = "Search message"
) {
    const navigationCardIcon =
        document.getElementById(
            "navigation-card-icon"
        );

    const searchCardIcon =
        document.getElementById(
            "search-card-icon"
        );

    const panelHeading =
        document.getElementById(
            "instructions-panel-heading"
        );

    const cardHeading =
        document.getElementById(
            "instructions-card-heading"
        );

    if (navigationCardIcon) {
        navigationCardIcon
            .classList
            .toggle(
                "hidden",
                isError
            );
    }

    if (searchCardIcon) {
        searchCardIcon
            .classList
            .toggle(
                "hidden",
                !isError
            );
    }

    if (panelHeading) {
        panelHeading.textContent =
            isError
                ? "Search result"
                : "Route Progress";
    }

    if (cardHeading) {
        cardHeading.textContent =
            isError
                ? heading
                : "Next step";
    }
}

// Current route HTTP request.
let routeRequestController = null;

async function fetchLiveRoute(
    lat,
    lng,
    destination
) {
    // Remove category markers because we
    // are starting navigation.
    clearCategoryMarkers();

    resetStepNavigation();

    if (stepsPanel) {
        stepsPanel.classList.add(
            "hidden"
        );
    }

    // Clear previous walking line.
    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(
            null
        );

        activeRoutePolyline =
            null;
    }

    const fetchUrl =
        `${SERVER_URL}/buildings` +
        `?to=${encodeURIComponent(
            destination
        )}` +
        `&userLat=${encodeURIComponent(
            lat
        )}` +
        `&userLng=${encodeURIComponent(
            lng
        )}`;

    // Stop an older unfinished route
    // request first.
    if (routeRequestController) {
        routeRequestController.abort();
    }

    const controller =
        new AbortController();

    routeRequestController =
        controller;

    const timeoutId =
        setTimeout(
            () => {
                controller.abort();
            },
            15000
        );

    if (navButtonText) {
        navButtonText.textContent =
            "Calculating route...";
    }

    if (routeLabel) {
        routeLabel.textContent =
            "Calculating...";
    }

    try {
        const response =
            await fetch(
                fetchUrl,
                {
                    signal:
                        controller.signal,

                    headers: {
                        Accept:
                            "application/json"
                    }
                }
            );

        const serverData =
            await response
                .json()
                .catch(
                    () => ({})
                );

        // Ignore old request responses.
        if (
            routeRequestController !==
            controller
        ) {
            return;
        }

        if (
            controller.signal.aborted
        ) {
            throw new Error(
                "The route request timed out. Please try again."
            );
        }

        if (!response.ok) {
            const error =
                new Error(
                    serverData.error ||
                    "Unable to find a route. Please try again."
                );

            error.code =
                serverData.code;

            throw error;
        }

        if (
            !Array.isArray(
                serverData.pathCoordinates
            ) ||
            serverData
                .pathCoordinates
                .length < 2
        ) {
            throw new Error(
                "The navigation server returned an incomplete route."
            );
        }

        // Validate all route coordinates
        // before trying to draw them.
        const validPath =
            serverData
                .pathCoordinates
                .every(
                    point =>
                        point &&
                        Number.isFinite(
                            point.lat
                        ) &&
                        Number.isFinite(
                            point.lng
                        )
                );

        if (!validPath) {
            throw new Error(
                "The navigation server returned invalid route coordinates."
            );
        }

        // Update destination information.
        if (destinationTitle) {
            destinationTitle.textContent =
                serverData.title;
        }

        if (destinationCategory) {
            destinationCategory.textContent =
                "Live Tracked Campus Venue";
        }

        if (walkTime) {
            walkTime.textContent =
                serverData.duration;
        }

        if (walkDistance) {
            walkDistance.textContent =
                serverData.distance;
        }

        // Map floating details.
        if (etaText) {
            etaText.textContent =
                serverData.duration;
        }

        if (mapDistancePill) {
            mapDistancePill.textContent =
                serverData.distance;
        }

        if (mapDestinationTitle) {
            mapDestinationTitle.textContent =
                serverData.title;
        }

        if (mapDestinationMeta) {
            mapDestinationMeta.textContent =
                "Walking route";
        }

        if (routeLabel) {
            routeLabel.textContent =
                "Walking route";
        }

        if (navButtonText) {
            navButtonText.textContent =
                "Navigation active";
        }

        // Begin the GPS-controlled
        // turn-by-turn instructions.
        startStepNavigation(
            serverData.navigationSteps
        );

        setInstructionsCardMode(
            false
        );

        if (stepsPanel) {
            stepsPanel.classList.remove(
                "hidden"
            );
        }

        renderBackendPolyline(
            serverData.pathCoordinates
        );
    }

    catch (err) {
        // Ignore an aborted request when
        // another route replaced it.
        if (
            routeRequestController !==
            controller
        ) {
            return;
        }

        resetStepNavigation();

        activeDestination =
            null;

        if (activeRoutePolyline) {
            activeRoutePolyline.setMap(
                null
            );

            activeRoutePolyline =
                null;
        }

        const notFound =
            err.code ===
            "LOCATION_NOT_FOUND";

        const timedOut =
            controller.signal.aborted;

        let heading;
        let message;

        if (notFound) {
            heading =
                "Location not found";

            message =
                "We couldn't find that location.\n" +
                "Try WSS, SMH, FNB, CM, CB, Matrix or Old Mutual.";
        }

        else if (timedOut) {
            heading =
                "Taking too long";

            message =
                "The route request took too long. Please try searching again.";
        }

        else if (
            err instanceof TypeError
        ) {
            heading =
                "Connection problem";

            message =
                "We couldn't reach the navigation server. Check your connection and try again.";
        }

        else {
            heading =
                "Route unavailable";

            message =
                err.message ||
                "Please try searching again.";
        }

        setInstructionsCardMode(
            true,
            heading
        );

        if (stepInstructionText) {
            stepInstructionText
                .style
                .whiteSpace =
                "pre-line";

            stepInstructionText
                .textContent =
                message;
        }

        if (stepsPanel) {
            stepsPanel.classList.remove(
                "hidden"
            );
        }

        if (routeLabel) {
            routeLabel.textContent =
                "No active route";
        }

        if (navButtonText) {
            navButtonText.textContent =
                "Search again";
        }

        if (destinationTitle) {
            destinationTitle.textContent =
                "No destination selected";
        }

        if (destinationCategory) {
            destinationCategory.textContent =
                "Search for a campus location";
        }

        if (mapDestinationTitle) {
            mapDestinationTitle.textContent =
                "No destination selected";
        }

        if (mapDestinationMeta) {
            mapDestinationMeta.textContent =
                "";
        }

        if (walkTime) {
            walkTime.textContent =
                "—";
        }

        if (walkDistance) {
            walkDistance.textContent =
                "—";
        }

        if (etaText) {
            etaText.textContent =
                "—";
        }

        if (mapDistancePill) {
            mapDistancePill.textContent =
                "—";
        }

        console.error(
            "Route request failed:",
            err
        );
    }

    finally {
        clearTimeout(
            timeoutId
        );

        if (
            routeRequestController ===
            controller
        ) {
            routeRequestController =
                null;
        }
    }
}


// =====================================================
// GPS WALKING STEP NAVIGATION
// =====================================================

let navigationSteps = [];
let currentStepIndex = 0;
let nearbyReadings = 0;
let lastStepReadingTime = 0;
let navigationFinished = false;

// Starting values for campus testing.
const STEP_RADIUS_METRES = 12;
const MAX_GPS_ERROR_METRES = 20;
const REQUIRED_NEARBY_READINGS = 2;

function distanceInMetres(
    a,
    b
) {
    const radians =
        degrees =>
            degrees *
            Math.PI /
            180;

    const earthRadius =
        6371000;

    const latitudeDifference =
        radians(
            b.lat - a.lat
        );

    const longitudeDifference =
        radians(
            b.lng - a.lng
        );

    const h =
        Math.sin(
            latitudeDifference / 2
        ) ** 2 +

        Math.cos(
            radians(a.lat)
        ) *

        Math.cos(
            radians(b.lat)
        ) *

        Math.sin(
            longitudeDifference / 2
        ) ** 2;

    return (
        2 *
        earthRadius *
        Math.asin(
            Math.sqrt(
                Math.min(
                    1,
                    Math.max(
                        0,
                        h
                    )
                )
            )
        )
    );
}

function showCurrentStep(
    note = ""
) {
    if (!stepInstructionText) {
        return;
    }

    const step =
        navigationSteps[
            currentStepIndex
        ];

    if (!step) {
        stepInstructionText.textContent =
            "";

        return;
    }

    const heading =
        navigationFinished
            ? "Arrived"
            : `Step ${currentStepIndex + 1} of ${navigationSteps.length}`;

    stepInstructionText
        .style
        .whiteSpace =
        "pre-line";

    stepInstructionText
        .textContent =
        `${heading}\n${step.instruction}` +
        (
            note
                ? `\n${note}`
                : ""
        );
}

function resetStepNavigation() {
    navigationSteps = [];
    currentStepIndex = 0;
    nearbyReadings = 0;
    lastStepReadingTime = 0;
    navigationFinished = false;

    if (stepInstructionText) {
        stepInstructionText.textContent =
            "";
    }
}

function startStepNavigation(
    steps
) {
    resetStepNavigation();

    const validSteps =
        Array.isArray(steps) &&
        steps.length > 0 &&
        steps.every(
            step =>
                typeof step.instruction ===
                    "string" &&

                Number.isFinite(
                    step.target?.lat
                ) &&

                Number.isFinite(
                    step.target?.lng
                )
        );

    if (!validSteps) {
        throw new Error(
            "Step coordinates are missing. Deploy the updated backend."
        );
    }

    navigationSteps =
        steps;

    showCurrentStep();
}

function updateStepFromGPS(
    position
) {
    if (
        !navigationSteps.length ||
        navigationFinished
    ) {
        return;
    }

    const timestamp =
        position.timestamp;

    const accuracy =
        position.coords
            .accuracy;

    // Ignore old GPS readings.
    if (
        !Number.isFinite(
            timestamp
        ) ||

        timestamp <=
            lastStepReadingTime ||

        Date.now() -
            timestamp >
            15000
    ) {
        return;
    }

    lastStepReadingTime =
        timestamp;

    // Don't advance a route step if
    // phone GPS is too inaccurate.
    if (
        !Number.isFinite(
            accuracy
        ) ||

        accuracy >
            MAX_GPS_ERROR_METRES
    ) {
        nearbyReadings = 0;

        showCurrentStep(
            "GPS accuracy is low. Waiting for a clearer location."
        );

        return;
    }

    const userPosition = {
        lat:
            position.coords
                .latitude,

        lng:
            position.coords
                .longitude
    };

    const step =
        navigationSteps[
            currentStepIndex
        ];

    const distance =
        distanceInMetres(
            userPosition,
            step.target
        );

    if (
        distance >
        STEP_RADIUS_METRES
    ) {
        nearbyReadings = 0;

        showCurrentStep();

        return;
    }

    nearbyReadings++;

    // Require two nearby readings so a
    // single GPS jump doesn't skip a step.
    if (
        nearbyReadings <
        REQUIRED_NEARBY_READINGS
    ) {
        return;
    }

    nearbyReadings = 0;

    if (
        currentStepIndex <
        navigationSteps.length - 1
    ) {
        currentStepIndex++;
    }

    const newStep =
        navigationSteps[
            currentStepIndex
        ];

    if (
        newStep.isArrival ||
        currentStepIndex ===
            navigationSteps.length - 1
    ) {
        navigationFinished =
            true;
    }

    showCurrentStep();
}


// =====================================================
// LOCATION SEARCH / SUGGESTIONS
// =====================================================

const locationSuggestions =
    document.getElementById(
        "location-suggestions"
    );

let searchableLocations = [];

function normaliseSearch(value) {
    return String(
        value || ""
    )
        .trim()
        .toLowerCase()
        .replace(
            /\s+/g,
            " "
        );
}

function updateLocationSuggestions() {
    const query =
        normaliseSearch(
            searchInput.value
        );

    locationSuggestions
        .replaceChildren();

    if (!query) {
        return;
    }

    const completeLocationSelected =
        searchableLocations.some(
            location =>
                normaliseSearch(
                    location.name
                ) === query
        );

    if (
        completeLocationSelected
    ) {
        return;
    }

    const matches =
        searchableLocations
            .map(
                location => {
                    const names = [
                        location.name,
                        location.id,
                        ...location.aliases
                    ].map(
                        normaliseSearch
                    );

                    let score = 0;

                    if (
                        names.some(
                            name =>
                                name ===
                                query
                        )
                    ) {
                        score = 3;
                    }

                    else if (
                        names.some(
                            name =>
                                name.startsWith(
                                    query
                                )
                        )
                    ) {
                        score = 2;
                    }

                    else if (
                        names.some(
                            name =>
                                name.includes(
                                    query
                                )
                        )
                    ) {
                        score = 1;
                    }

                    return {
                        location,
                        score
                    };
                }
            )
            .filter(
                match =>
                    match.score > 0
            )
            .sort(
                (a, b) =>
                    b.score -
                        a.score ||

                    a.location.name
                        .localeCompare(
                            b.location.name
                        )
            )
            .slice(
                0,
                8
            );

    for (
        const {
            location
        } of matches
    ) {
        const option =
            document.createElement(
                "option"
            );

        option.value =
            location.name;

        option.label = [
            location.id,
            ...location.aliases
        ].join(" • ");

        locationSuggestions
            .appendChild(
                option
            );
    }
}

searchInput.addEventListener(
    "input",
    updateLocationSuggestions
);

async function loadLocationSuggestions() {
    const controller =
        new AbortController();

    const timeoutId =
        setTimeout(
            () =>
                controller.abort(),
            10000
        );

    try {
        const response =
            await fetch(
                `${SERVER_URL}/locations`,
                {
                    signal:
                        controller.signal,

                    headers: {
                        Accept:
                            "application/json"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                "Unable to load location suggestions."
            );
        }

        const locations =
            await response.json();

        if (
            !Array.isArray(
                locations
            )
        ) {
            throw new Error(
                "Invalid location list."
            );
        }

        searchableLocations =
            locations
                .filter(
                    location =>
                        location &&
                        typeof location.name ===
                            "string"
                )
                .map(
                    location => ({
                        id:
                            location.id ||
                            "",

                        name:
                            location.name,

                        aliases:
                            Array.isArray(
                                location.aliases
                            )
                                ? location.aliases
                                : []
                    })
                );

        updateLocationSuggestions();
    }

    catch (error) {
        console.warn(
            "Location suggestions unavailable:",
            error.message
        );
    }

    finally {
        clearTimeout(
            timeoutId
        );
    }
}

loadLocationSuggestions();


// =====================================================
// QUICK ACCESS CATEGORY MARKERS
// =====================================================

function clearCategoryMarkers() {
    if (
        categoryRequestController
    ) {
        categoryRequestController
            .abort();

        categoryRequestController =
            null;
    }

    categoryMarkers.forEach(
        marker =>
            marker.setMap(
                null
            )
    );

    categoryMarkers = [];

    if (categoryInfoWindow) {
        categoryInfoWindow.close();
    }

    activeMapCategory =
        null;
}

function showCategoryMessage(
    message
) {
    setInstructionsCardMode(
        true,
        "Map locations"
    );

    const panelHeading =
        document.getElementById(
            "instructions-panel-heading"
        );

    if (panelHeading) {
        panelHeading.textContent =
            "Map locations";
    }

    if (stepInstructionText) {
        stepInstructionText.textContent =
            message;
    }

    if (stepsPanel) {
        stepsPanel.classList.remove(
            "hidden"
        );
    }
}

async function showLocationCategory(
    category,
    title
) {
    if (
        !map ||
        !window.google?.maps
    ) {
        showCategoryMessage(
            "The map is still loading. Please try again."
        );

        return;
    }

    clearCategoryMarkers();

    // Stop route request so an old route
    // cannot appear after category markers.
    if (routeRequestController) {
        routeRequestController.abort();

        routeRequestController =
            null;
    }

    activeDestination =
        null;

    resetStepNavigation();

    if (activeRoutePolyline) {
        activeRoutePolyline.setMap(
            null
        );

        activeRoutePolyline =
            null;
    }

    activeMapCategory =
        category;

    searchInput.value =
        "";

    searchInput.blur();

    locationSuggestions
        ?.replaceChildren();

    if (destinationTitle) {
        destinationTitle.textContent =
            title;
    }

    if (destinationCategory) {
        destinationCategory.textContent =
            "Saved campus locations";
    }

    if (walkTime) {
        walkTime.textContent =
            "—";
    }

    if (walkDistance) {
        walkDistance.textContent =
            "—";
    }

    if (etaText) {
        etaText.textContent =
            "—";
    }

    if (mapDistancePill) {
        mapDistancePill.textContent =
            "—";
    }

    if (routeLabel) {
        routeLabel.textContent =
            title;
    }

    showCategoryMessage(
        `Loading ${title.toLowerCase()}...`
    );

    const controller =
        new AbortController();

    categoryRequestController =
        controller;

    const timeoutId =
        setTimeout(
            () =>
                controller.abort(),
            12000
        );

    try {
        const response =
            await fetch(
                `${SERVER_URL}/locations`,
                {
                    signal:
                        controller.signal,

                    headers: {
                        Accept:
                            "application/json"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                "Locations could not be loaded."
            );
        }

        const locations =
            await response.json();

        if (
            categoryRequestController !==
            controller
        ) {
            return;
        }

        if (
            !Array.isArray(
                locations
            )
        ) {
            throw new Error(
                "Invalid locations response."
            );
        }

        const matches =
            locations.filter(
                location =>
                    location.category ===
                        category &&

                    typeof location.name ===
                        "string" &&

                    Number.isFinite(
                        location.lat
                    ) &&

                    Number.isFinite(
                        location.lng
                    ) &&

                    Math.abs(
                        location.lat
                    ) <= 90 &&

                    Math.abs(
                        location.lng
                    ) <= 180
            );

        if (
            matches.length === 0
        ) {
            showCategoryMessage(
                `No ${title.toLowerCase()} have been saved with coordinates yet.`
            );

            return;
        }

        const bounds =
            new google.maps
                .LatLngBounds();

        if (!categoryInfoWindow) {
            categoryInfoWindow =
                new google.maps
                    .InfoWindow();
        }

        matches.forEach(
            location => {
                const position = {
                    lat:
                        location.lat,

                    lng:
                        location.lng
                };

                const marker =
                    new google.maps.Marker({
                        map,

                        position,

                        title:
                            location.name,

                        label: {
                            text:
                                location.name,

                            color:
                                "#002855",

                            fontSize:
                                "12px",

                            fontWeight:
                                "700",

                            className:
                                "venue-marker-label"
                        },

                        icon: {
                            path:
                                google.maps
                                    .SymbolPath
                                    .CIRCLE,

                            scale: 8,

                            fillColor:
                                category ===
                                "residence"
                                    ? "#ffb81c"
                                    : "#059669",

                            fillOpacity:
                                1,

                            strokeColor:
                                "#ffffff",

                            strokeWeight:
                                2,

                            labelOrigin:
                                new google.maps
                                    .Point(
                                        0,
                                        3
                                    )
                        }
                    });

                marker.addListener(
                    "click",
                    () => {
                        const content =
                            document
                                .createElement(
                                    "div"
                                );

                        content.textContent =
                            location.name;

                        content.style.fontWeight =
                            "700";

                        content.style.color =
                            "#002855";

                        categoryInfoWindow
                            .setContent(
                                content
                            );

                        categoryInfoWindow
                            .open({
                                map,
                                anchor:
                                    marker
                            });
                    }
                );

                categoryMarkers.push(
                    marker
                );

                bounds.extend(
                    position
                );
            }
        );

        if (
            matches.length === 1
        ) {
            map.setCenter({
                lat:
                    matches[0].lat,

                lng:
                    matches[0].lng
            });

            map.setZoom(
                17
            );
        }

        else {
            map.fitBounds(
                bounds,
                80
            );
        }

        if (destinationCategory) {
            destinationCategory.textContent =
                `${matches.length} saved locations`;
        }

        showCategoryMessage(
            `Showing ${matches.length} ${title.toLowerCase()}. ` +
            "Tap a marker to see its name."
        );
    }

    catch (error) {
        if (
            categoryRequestController !==
            controller
        ) {
            return;
        }

        clearCategoryMarkers();

        showCategoryMessage(
            error.name ===
            "AbortError"

                ? "Loading locations took too long. Please try again."

                : "Could not load the locations. Please try again."
        );
    }

    finally {
        clearTimeout(
            timeoutId
        );

        if (
            categoryRequestController ===
            controller
        ) {
            categoryRequestController =
                null;
        }
    }
}


// =====================================================
// QUICK ACCESS BUTTONS
// =====================================================

document
    .querySelectorAll(
        ".quick-access"
    )
    .forEach(
        button => {
            button.addEventListener(
                "click",
                () => {
                    const place =
                        button.dataset
                            .place;

                    if (
                        place ===
                        "Residences"
                    ) {
                        showLocationCategory(
                            "residence",
                            "Residences"
                        );

                        return;
                    }

                    if (
                        place ===
                        "Campus Entrances"
                    ) {
                        showLocationCategory(
                            "entrance",
                            "Campus Entrances"
                        );

                        return;
                    }

                    if (
                        place ===
                        "Emergency Services"
                    ) {
                        const emergencyButton =
                            document.getElementById(
                                "nav-emergency-btn"
                            ) ||

                            document.getElementById(
                                "sidebar-emergency-btn"
                            );

                        emergencyButton
                            ?.click();
                    }
                }
            );
        }
    );


// =====================================================
// SEARCH ENTER
// =====================================================

searchInput.addEventListener(
    "keydown",
    event => {
        if (
            event.key !== "Enter" ||
            event.isComposing
        ) {
            return;
        }

        event.preventDefault();

        const value =
            searchInput
                .value
                .trim();

        if (!value) {
            return;
        }

        // Close mobile keyboard.
        searchInput.blur();

        updateDestination(
            value
        );
    }
);


// =====================================================
// RECENTER BUTTON
// =====================================================

const recenterButton =
    document.getElementById(
        "recenter-button"
    );

if (recenterButton) {
    recenterButton.addEventListener(
        "click",
        () => {
            if (!map) {
                return;
            }

            if (
                userMarker &&
                userMarker.getPosition()
            ) {
                map.setCenter(
                    userMarker
                        .getPosition()
                );

                map.setZoom(
                    17
                );

                return;
            }

            map.setCenter({
                lat: -26.1906,
                lng: 28.0286
            });

            map.setZoom(
                16
            );
        }
    );
}

const gpsPill =
    document.getElementById(
        "gps-pill"
    );

const gpsText =
    document.getElementById(
        "gps-text"
    );


// =====================================================
// TAB SWITCHING
// =====================================================

function setActiveTab(
    activeButton
) {
    try {
        sessionStorage.setItem(
            "witsNavActiveTab",
            activeButton
        );
    }

    catch (error) {
        // Tabs still work if browser
        // storage is unavailable.
    }

    const mobileTabs = [
        navHomeBtn,
        navSearchBtn,
        navAbbrevBtn,
        navEmergencyBtn
    ];

    const targetMobile =
        document.getElementById(
            `nav-${activeButton}-btn`
        );

    mobileTabs.forEach(
        tab => {
            if (
                tab &&
                tab ===
                    targetMobile
            ) {
                tab.classList.add(
                    "text-wits-gold",
                    "font-bold"
                );

                tab.classList.remove(
                    "text-slate-400",
                    "hover:text-wits-900"
                );
            }

            else if (tab) {
                tab.classList.remove(
                    "text-wits-gold",
                    "font-bold"
                );

                tab.classList.add(
                    "text-slate-400",
                    "hover:text-wits-900"
                );
            }
        }
    );

    const sidebarTabs = [
        sidebarHomeBtn,
        sidebarSearchBtn,
        sidebarAbbrevBtn,
        sidebarEmergencyBtn
    ];

    const targetSidebar =
        document.getElementById(
            `sidebar-${activeButton}-btn`
        );

    sidebarTabs.forEach(
        btn => {
            if (
                btn &&
                btn ===
                    targetSidebar
            ) {
                btn.className =
                    "w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-wits-gold text-wits-900 font-bold text-sm transition";
            }

            else if (btn) {
                btn.className =
                    "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-blue-100 hover:bg-white/10 font-medium text-sm transition";
            }
        }
    );
}

function restoreActiveTab() {
    let savedTab =
        "home";

    try {
        savedTab =
            sessionStorage
                .getItem(
                    "witsNavActiveTab"
                ) ||
            "home";
    }

    catch (error) {
        // Default to home.
    }

    const tabButtons =
        new Map([
            [
                "home",
                navHomeBtn ||
                sidebarHomeBtn
            ],

            [
                "abbrev",
                navAbbrevBtn ||
                sidebarAbbrevBtn
            ],

            [
                "emergency",
                navEmergencyBtn ||
                sidebarEmergencyBtn
            ]
        ]);

    const button =
        tabButtons.get(
            savedTab
        ) ||
        tabButtons.get(
            "home"
        );

    if (button) {
        button.click();
    }
}

if (navHomeBtn) {
    navHomeBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "home"
            );

            abbrevScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .add(
                    "hidden"
                );

            homeScreen
                .classList
                .remove(
                    "hidden"
                );
        }
    );
}

if (sidebarHomeBtn) {
    sidebarHomeBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "home"
            );

            abbrevScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .add(
                    "hidden"
                );

            homeScreen
                .classList
                .remove(
                    "hidden"
                );
        }
    );
}

if (navAbbrevBtn) {
    navAbbrevBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "abbrev"
            );

            homeScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .add(
                    "hidden"
                );

            abbrevScreen
                .classList
                .remove(
                    "hidden"
                );
        }
    );
}

if (sidebarAbbrevBtn) {
    sidebarAbbrevBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "abbrev"
            );

            homeScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .add(
                    "hidden"
                );

            abbrevScreen
                .classList
                .remove(
                    "hidden"
                );
        }
    );
}

if (navEmergencyBtn) {
    navEmergencyBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "emergency"
            );

            homeScreen
                .classList
                .add(
                    "hidden"
                );

            abbrevScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .remove(
                    "hidden"
                );

            runEmergencyFilter(
                "medical"
            );
        }
    );
}

if (sidebarEmergencyBtn) {
    sidebarEmergencyBtn.addEventListener(
        "click",
        () => {
            setActiveTab(
                "emergency"
            );

            homeScreen
                .classList
                .add(
                    "hidden"
                );

            abbrevScreen
                .classList
                .add(
                    "hidden"
                );

            emergencyScreen
                .classList
                .remove(
                    "hidden"
                );

            runEmergencyFilter(
                "medical"
            );
        }
    );
}


// =====================================================
// CLEAR NAVIGATION
// =====================================================

if (cancelNavBtn) {
    cancelNavBtn.addEventListener(
        "click",
        () => {
            clearCategoryMarkers();

            activeDestination =
                null;

            if (destinationTitle) {
                destinationTitle.textContent =
                    "No destination selected";
            }

            if (destinationCategory) {
                destinationCategory.textContent =
                    "Search or choose Quick Access";
            }

            if (
                routeRequestController
            ) {
                routeRequestController
                    .abort();

                routeRequestController =
                    null;
            }

            resetStepNavigation();

            if (
                activeRoutePolyline
            ) {
                activeRoutePolyline
                    .setMap(
                        null
                    );

                activeRoutePolyline =
                    null;
            }

            if (routeLabel) {
                routeLabel.textContent =
                    "No active route";
            }

            if (walkTime) {
                walkTime.textContent =
                    "—";
            }

            if (walkDistance) {
                walkDistance.textContent =
                    "—";
            }

            if (etaText) {
                etaText.textContent =
                    "—";
            }

            if (mapDistancePill) {
                mapDistancePill.textContent =
                    "—";
            }

            if (mapDestinationTitle) {
                mapDestinationTitle.textContent =
                    "No destination selected";
            }

            if (mapDestinationMeta) {
                mapDestinationMeta.textContent =
                    "";
            }

            if (stepsPanel) {
                stepsPanel
                    .classList
                    .add(
                        "hidden"
                    );
            }

            searchInput.value =
                "";

            locationSuggestions
                ?.replaceChildren();

            if (
                userMarker &&
                userMarker.getPosition()
            ) {
                map.setCenter(
                    userMarker
                        .getPosition()
                );

                map.setZoom(
                    16
                );
            }
        }
    );
}


// =====================================================
// EMERGENCY FILTER
// =====================================================

function runEmergencyFilter(
    selectedType
) {
    const filterButtons = [
        filterMedicalBtn,
        filterSecurityBtn,
        filterContactsBtn
    ];

    filterButtons.forEach(
        btn => {
            if (!btn) {
                return;
            }

            const desktopHideClass =
                btn ===
                filterContactsBtn
                    ? " lg:hidden"
                    : "";

            const active =
                (
                    selectedType ===
                        "medical" &&
                    btn ===
                        filterMedicalBtn
                ) ||

                (
                    selectedType ===
                        "security" &&
                    btn ===
                        filterSecurityBtn
                ) ||

                (
                    selectedType ===
                        "contacts" &&
                    btn ===
                        filterContactsBtn
                );

            if (active) {
                btn.className =
                    "px-4 py-1.5 text-xs font-bold bg-wits-900 text-white rounded-full whitespace-nowrap transition" +
                    desktopHideClass;
            }

            else {
                btn.className =
                    "px-4 py-1.5 text-xs font-medium bg-white text-slate-600 border border-slate-200 rounded-full whitespace-nowrap hover:bg-slate-50 transition" +
                    desktopHideClass;
            }
        }
    );

    const isDesktop =
        window.innerWidth >=
        1024;

    if (isDesktop) {
        if (
            contactsSidebarPanel
        ) {
            contactsSidebarPanel
                .className =
                "hidden lg:block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle sticky top-24";
        }

        medicalCards.forEach(
            card =>
                card.classList
                    .toggle(
                        "hidden",
                        selectedType !==
                            "medical"
                    )
        );

        securityCards.forEach(
            card =>
                card.classList
                    .toggle(
                        "hidden",
                        selectedType !==
                            "security"
                    )
        );

        return;
    }

    if (
        selectedType ===
        "medical"
    ) {
        medicalCards.forEach(
            card =>
                card.classList
                    .remove(
                        "hidden"
                    )
        );

        securityCards.forEach(
            card =>
                card.classList
                    .add(
                        "hidden"
                    )
        );

        if (
            contactsSidebarPanel
        ) {
            contactsSidebarPanel
                .className =
                "hidden";
        }
    }

    else if (
        selectedType ===
        "security"
    ) {
        medicalCards.forEach(
            card =>
                card.classList
                    .add(
                        "hidden"
                    )
        );

        securityCards.forEach(
            card =>
                card.classList
                    .remove(
                        "hidden"
                    )
        );

        if (
            contactsSidebarPanel
        ) {
            contactsSidebarPanel
                .className =
                "hidden";
        }
    }

    else if (
        selectedType ===
        "contacts"
    ) {
        medicalCards.forEach(
            card =>
                card.classList
                    .add(
                        "hidden"
                    )
        );

        securityCards.forEach(
            card =>
                card.classList
                    .add(
                        "hidden"
                    )
        );

        if (
            contactsSidebarPanel
        ) {
            contactsSidebarPanel
                .className =
                "block bg-white border border-slate-200/80 rounded-2xl p-5 shadow-subtle -mt-6";
        }
    }
}

if (filterMedicalBtn) {
    filterMedicalBtn
        .addEventListener(
            "click",
            () =>
                runEmergencyFilter(
                    "medical"
                )
        );
}

if (filterSecurityBtn) {
    filterSecurityBtn
        .addEventListener(
            "click",
            () =>
                runEmergencyFilter(
                    "security"
                )
        );
}

if (filterContactsBtn) {
    filterContactsBtn
        .addEventListener(
            "click",
            () =>
                runEmergencyFilter(
                    "contacts"
                )
        );
}

window.addEventListener(
    "resize",
    () => {
        const isMedicalActive =
            filterMedicalBtn &&
            filterMedicalBtn
                .classList
                .contains(
                    "bg-wits-900"
                );

        const isSecurityActive =
            filterSecurityBtn &&
            filterSecurityBtn
                .classList
                .contains(
                    "bg-wits-900"
                );

        const isContactsActive =
            filterContactsBtn &&
            filterContactsBtn
                .classList
                .contains(
                    "bg-wits-900"
                );

        const isDesktop =
            window.innerWidth >=
            1024;

        if (isMedicalActive) {
            runEmergencyFilter(
                "medical"
            );
        }

        else if (
            isSecurityActive
        ) {
            runEmergencyFilter(
                "security"
            );
        }

        else if (
            isContactsActive
        ) {
            if (isDesktop) {
                runEmergencyFilter(
                    "medical"
                );
            }

            else {
                runEmergencyFilter(
                    "contacts"
                );
            }
        }
    }
);


// =====================================================
// ABBREVIATION FILTER
// =====================================================

function filterAbbreviations(
    query
) {
    const sanitizedQuery =
        query
            .trim()
            .toLowerCase();

    const cards =
        document.querySelectorAll(
            ".abbrev-card"
        );

    cards.forEach(
        card => {
            const acronymElement =
                card.querySelector(
                    "span"
                );

            const titleElement =
                card.querySelector(
                    "h4"
                );

            const acronymText =
                acronymElement
                    ? acronymElement
                        .textContent
                        .toLowerCase()
                    : "";

            const titleText =
                titleElement
                    ? titleElement
                        .textContent
                        .toLowerCase()
                    : "";

            if (
                acronymText.includes(
                    sanitizedQuery
                ) ||

                titleText.includes(
                    sanitizedQuery
                )
            ) {
                card.style.display =
                    "";
            }

            else {
                card.style.display =
                    "none";
            }
        }
    );
}

// Keep this function global because your
// existing HTML calls it through oninput.
window.filterAbbreviations =
    filterAbbreviations;


// =====================================================
// ROUTE-TO BUTTONS
// =====================================================

document
    .querySelectorAll(
        "[data-route-to]"
    )
    .forEach(
        button => {
            button.addEventListener(
                "click",
                () => {
                    const destination =
                        button
                            .dataset
                            .routeTo
                            ?.trim();

                    if (!destination) {
                        return;
                    }

                    const homeButton =
                        navHomeBtn ||
                        sidebarHomeBtn;

                    if (homeButton) {
                        homeButton.click();
                    }

                    searchInput.value =
                        destination;

                    locationSuggestions
                        .replaceChildren();

                    searchInput.blur();

                    searchInput
                        .scrollIntoView({
                            behavior:
                                "smooth",

                            block:
                                "center"
                        });

                    updateDestination(
                        destination
                    );
                }
            );
        }
    );


// Restore saved tab or default to Home.
restoreActiveTab();