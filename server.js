const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const STOCK_ROOT = process.env.STOCK_ROOT || path.join(__dirname, 'stock_photos');
app.use('/photos', express.static(STOCK_ROOT));

function getWhitelist() {
    try {
        if (fs.existsSync(WHITELIST_FILE)) {
            return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        }
    } catch (err) {}
    return { "DeWet": "TSM-ADMIN" };
}

// Function to auto-push whitelist changes to GitHub so they persist across deploys
function saveAndPushWhitelist(whitelistData) {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelistData, null, 2), 'utf8');

    const token = process.env.GITHUB_TOKEN;
    if (!token) return; // If token isn't set yet, just save locally

    const repo = 'TSM-hubs/tsm-stock';
    const filePath = 'whitelist.json';
    const fileContent = Buffer.from(JSON.stringify(whitelistData, null, 2)).toString('base64');

    // Step 1: Get current file SHA on GitHub
    const getOptions = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${filePath}`,
        method: 'GET',
        headers: { 'User-Agent': 'TSM-Stock-App', 'Authorization': `token ${token}` }
    };

    https.get(getOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            let sha = '';
            try {
                sha = JSON.parse(data).sha;
            } catch (e) {}

            // Step 2: Update file on GitHub
            const payload = JSON.stringify({
                message: 'Auto-update whitelist via Admin Panel',
                content: fileContent,
                sha: sha
            });

            const putOptions = {
                hostname: 'api.github.com',
                path: `/repos/${repo}/contents/${filePath}`,
                method: 'PUT',
                headers: {
                    'User-Agent': 'TSM-Stock-App',
                    'Authorization': `token ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const req = https.request(putOptions, (putRes) => {
                // Successfully pushed to GitHub
            });
            req.write(payload);
            req.end();
        });
    }).on('error', (err) => {
        console.error('GitHub sync error:', err);
    });
}

const BRAND_ALIASES = {
    'vw': 'volkswagen', 'volks': 'volkswagen', 'merc': 'mercedes', 'mb': 'mercedes', 'benz': 'mercedes',
    'ota': 'toyota', 'toy': 'toyota', 'chevy': 'chevrolet', 'chev': 'chevrolet', 'bimmer': 'bmw',
    'beamer': 'bmw', 'propeller': 'bmw', 'landy': 'land rover', 'range': 'land rover', 'issan': 'nissan',
    'mitsun': 'mitsubishi', 'mitsu': 'mitsubishi', 'porsh': 'porsche', 'hyund': 'hyundai', 'isuz': 'isuzu'
};

function formatFolderToUI(folderName) {
    const lastHyphen = folderName.lastIndexOf('-');
    if (lastHyphen === -1) return { vehicle: folderName, color: 'Standard', reg: 'New Stock' };

    const vehicle = folderName.substring(0, lastHyphen).trim();
    const colorOrReg = folderName.substring(lastHyphen + 1).trim();
    const isRegistration = /\d/.test(colorOrReg) && colorOrReg.length > 5;

    if (isRegistration) {
        const secondLastHyphen = folderName.lastIndexOf('-', lastHyphen - 1);
        if (secondLastHyphen !== -1) {
            return {
                vehicle: folderName.substring(0, secondLastHyphen).trim(),
                color: folderName.substring(secondLastHyphen + 1, lastHyphen).trim(),
                reg: colorOrReg
            };
        }
    }
    return { vehicle: vehicle, color: colorOrReg, reg: '✨ New Stock' };
}

// --- WHITELIST SECURITY MIDDLEWARE ---
app.use((req, res, next) => {
    if (req.path === '/pending' || req.path.startsWith('/admin')) return next();

    let deviceToken = req.cookies.tsm_device_token;
    if (!deviceToken) {
        deviceToken = 'TSM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        res.cookie('tsm_device_token', deviceToken, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
    }

    const whitelist = getWhitelist();
    const authorizedTokens = Object.values(whitelist);

    if (!authorizedTokens.includes(deviceToken)) {
        return res.render('pending', { token: deviceToken });
    }

    next();
});

app.get('/', (req, res) => {
    res.render('index', { matches: null, query: '' });
});

app.get('/pending', (req, res) => {
    const deviceToken = req.cookies.tsm_device_token;
    res.render('pending', { token: deviceToken });
});

app.post('/search', (req, res) => {
    let query = (req.body.query || '').trim().toLowerCase();
    if (BRAND_ALIASES[query]) query = BRAND_ALIASES[query];

    let allMatches = [];
    if (!fs.existsSync(STOCK_ROOT)) return res.render('index', { matches: [], query });

    const brandFolders = fs.readdirSync(STOCK_ROOT).filter(f => fs.statSync(path.join(STOCK_ROOT, f)).isDirectory());

    for (const brand of brandFolders) {
        const brandPath = path.join(STOCK_ROOT, brand);
        const vehicleFolders = fs.readdirSync(brandPath).filter(f => fs.statSync(path.join(brandPath, f)).isDirectory() && f.toLowerCase() !== 'watermark');
        const matches = vehicleFolders.filter(f => f.toLowerCase().includes(query) || brand.toLowerCase().includes(query));
        for (const match of matches) {
            const ui = formatFolderToUI(match);
            allMatches.push({ brand, folderName: match, ui });
        }
    }

    allMatches.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { numeric: true, sensitivity: 'base' }));
    res.render('index', { matches: allMatches, query });
});

app.get('/vehicle', (req, res) => {
    const { brand, folder } = req.query;
    const targetPath = path.join(STOCK_ROOT, brand, folder);

    if (!fs.existsSync(targetPath)) return res.send('Folder not found.');

    const images = fs.readdirSync(targetPath)
        .filter(f => /\.(jpg|jpeg)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    res.render('vehicle', { brand, folder, images, ui: formatFolderToUI(folder) });
});

// --- ADMIN PANEL ROUTES ---
app.get('/admin', (req, res) => {
    res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        res.cookie('tsm_admin', 'true', { httpOnly: true });
        return res.redirect('/admin/dashboard');
    }
    res.render('admin-login', { error: 'Incorrect password' });
});

app.get('/admin/dashboard', (req, res) => {
    if (req.cookies.tsm_admin !== 'true') return res.redirect('/admin');
    const whitelist = getWhitelist();
    res.render('admin-dashboard', { whitelist });
});

app.post('/admin/add', (req, res) => {
    if (req.cookies.tsm_admin !== 'true') return res.redirect('/admin');
    const { name, token } = req.body;
    if (name && token) {
        const whitelist = getWhitelist();
        whitelist[name.trim()] = token.trim();
        saveAndPushWhitelist(whitelist);
    }
    res.redirect('/admin/dashboard');
});

app.post('/admin/remove', (req, res) => {
    if (req.cookies.tsm_admin !== 'true') return res.redirect('/admin');
    const { name } = req.body;
    const whitelist = getWhitelist();
    delete whitelist[name];
    saveAndPushWhitelist(whitelist);
    res.redirect('/admin/dashboard');
});

app.listen(PORT, () => {
    console.log(`TSM Stock Portal running live on port ${PORT}`);
});