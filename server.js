const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const DRIVE_ROOT_FOLDER_ID = '1h-SXsg1CLoU2_g7uIf4jT6UHE0kP_2WE';

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

function getWhitelist() {
    try {
        if (require('fs').existsSync(WHITELIST_FILE)) {
            return JSON.parse(require('fs').readFileSync(WHITELIST_FILE, 'utf8'));
        }
    } catch (err) {}
    return { "DeWet": "TSM-ADMIN" };
}

function saveAndPushWhitelist(whitelistData) {
    require('fs').writeFileSync(WHITELIST_FILE, JSON.stringify(whitelistData, null, 2), 'utf8');
    const token = process.env.GITHUB_TOKEN;
    if (!token) return;

    const repo = 'TSM-hubs/tsm-stock';
    const filePath = 'whitelist.json';
    const fileContent = Buffer.from(JSON.stringify(whitelistData, null, 2)).toString('base64');

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
            try { sha = JSON.parse(data).sha; } catch (e) {}

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

            const req = https.request(putOptions, () => {});
            req.write(payload);
            req.end();
        });
    }).on('error', () => {});
}

function queryGoogleDrive(apiPath) {
    return new Promise((resolve, reject) => {
        const url = `https://www.googleapis.com/drive/v3/files?${apiPath}&key=${DRIVE_API_KEY}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
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

app.post('/search', async (req, res) => {
    let query = (req.body.query || '').trim().toLowerCase();
    if (BRAND_ALIASES[query]) query = BRAND_ALIASES[query];

    try {
        const brandQuery = `q='${DRIVE_ROOT_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`;
        const brandResult = await queryGoogleDrive(brandQuery);
        const brandFolders = brandResult.files || [];

        let allMatches = [];

        for (const brand of brandFolders) {
            const vehicleQuery = `q='${brand.id}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`;
            const vehicleResult = await queryGoogleDrive(vehicleQuery);
            const vehicleFolders = vehicleResult.files || [];

            for (const vehicleFolder of vehicleFolders) {
                if (vehicleFolder.name.toLowerCase() === 'watermark') continue;

                if (vehicleFolder.name.toLowerCase().includes(query) || brand.name.toLowerCase().includes(query)) {
                    const ui = formatFolderToUI(vehicleFolder.name);
                    allMatches.push({ brand: brand.name, folderName: vehicleFolder.name, folderId: vehicleFolder.id, ui });
                }
            }
        }

        allMatches.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { numeric: true, sensitivity: 'base' }));
        res.render('index', { matches: allMatches, query });
    } catch (err) {
        res.render('index', { matches: [], query });
    }
});

app.get('/vehicle', async (req, res) => {
    const { brand, folder, id } = req.query;

    try {
        let folderId = id;
        if (!folderId && folder) {
            const q = `q=name='${folder.replace(/'/g, "\\'")}'+\\and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`;
            const result = await queryGoogleDrive(q);
            if (result.files && result.files.length > 0) folderId = result.files[0].id;
        }

        if (!folderId) return res.status(404).send('Folder not found in Google Drive.');

        // Fetch images and strictly exclude .png files by name and MIME type
        const imgQuery = `q='${folderId}'+in+parents+and+mimeType+contains+'image/'+and+trashed=false&fields=files(id,name,mimeType)&orderBy=name`;
        const imgResult = await queryGoogleDrive(imgQuery);
        const images = (imgResult.files || [])
            .filter(file => {
                const name = (file.name || '').toLowerCase();
                const mime = (file.mimeType || '').toLowerCase();
                return !name.endsWith('.png') && mime !== 'image/png';
            })
            .map(file => `https://lh3.googleusercontent.com/d/${file.id}`);

        res.render('vehicle', { brand: brand || 'Vehicle', folder: folder || 'Details', folderId, images, ui: formatFolderToUI(folder || '') });
    } catch (err) {
        res.status(500).send('Error loading images from Google Drive.');
    }
});

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