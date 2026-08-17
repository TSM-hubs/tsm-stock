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

// Proxy Route to Force Download
app.get('/download', (req, res) => {
    const fileUrl = req.query.url;
    if (!fileUrl) return res.status(400).send('No file provided');
    res.setHeader('Content-Disposition', 'attachment; filename="TSM-Photo.jpg"');
    https.get(fileUrl, (imageRes) => {
        imageRes.pipe(res);
    }).on('error', (e) => res.status(500).send('Download failed'));
});

app.use((req, res, next) => {
    if (req.path === '/pending' || req.path.startsWith('/admin') || req.path === '/download') return next();

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

app.get('/', (req, res) => res.render('index', { matches: null, query: '' }));
app.get('/pending', (req, res) => res.render('pending', { token: req.cookies.tsm_device_token }));

app.post('/search', async (req, res) => {
    let query = (req.body.query || '').trim().toLowerCase();
    try {
        const brandQuery = `q='${DRIVE_ROOT_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`;
        const brandResult = await queryGoogleDrive(brandQuery);
        let allMatches = [];
        for (const brand of (brandResult.files || [])) {
            const vResult = await queryGoogleDrive(`q='${brand.id}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`);
            for (const vFolder of (vResult.files || [])) {
                if (vFolder.name.toLowerCase().includes(query) || brand.name.toLowerCase().includes(query)) {
                    allMatches.push({ brand: brand.name, folderName: vFolder.name, folderId: vFolder.id, ui: formatFolderToUI(vFolder.name) });
                }
            }
        }
        res.render('index', { matches: allMatches, query });
    } catch (err) { res.render('index', { matches: [], query }); }
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
        if (!folderId) return res.status(404).send('Folder not found.');
        const imgResult = await queryGoogleDrive(`q='${folderId}'+in+parents+and+mimeType+contains+'image/'+and+trashed=false&fields=files(id,name,mimeType)&orderBy=name`);
        const images = (imgResult.files || []).filter(f => !f.name.toLowerCase().endsWith('.png') && f.mimeType !== 'image/png').map(f => `https://lh3.googleusercontent.com/d/${f.id}`);
        res.render('vehicle', { brand, folder, folderId, images, ui: formatFolderToUI(folder || '') });
    } catch (err) { res.status(500).send('Error loading images.'); }
});

app.listen(PORT, () => console.log(`Running on ${PORT}`));