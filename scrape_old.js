const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const puppeteer = require('puppeteer');
const robotsParser = require('robots-parser');
const sharp = require('sharp');

const { TimeoutError } = require('puppeteer');

(async () => {
    const visitedUrls = new Set();
    const trashDirectory = path.join(__dirname, 'trash');
    const errorLogPath = path.join(__dirname, 'error.log');
    const sitemapPath = path.join(__dirname, 'sitemap.xml');
    const userAgent = '7MMCrawler/0.4';
    const mainUrl = 'https://bigwheelskating.com';
    const robotsUrl = mainUrl + '/robots.txt';
    const browserOptions = {
        timeout: 120000, // Increase the overall timeout to 120 seconds
        puppeteerOptions: {
            protocolTimeout: 120000, // Increase the protocol timeout to 120 seconds
            args: ['--start-maximized']
        }
    };

    // Promisify fs.appendFile to simplify error logging
    const appendFileAsync = fs.appendFile;

    async function logError(error) {
        await appendFileAsync(errorLogPath, `${new Date().toISOString()} - ${error}\n`);
    }

    async function crawlWebsite(url, browser, baseUrl, robots, page, pageDirectory, retryCount = 3) {
        if (!isValidUrl(url) || visitedUrls.has(url) || !url.startsWith(baseUrl)) {
            return;
        }
        console.log('Scraping URL:', url);
        visitedUrls.add(url);
    
        try {
            // Navigate to the URL
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    
            // Wait for a specific selector to appear on the page
            await page.waitForSelector('body');
    
            // Extract page content using Cheerio
            const content = await page.content();
            const $ = cheerio.load(content);
    
            // Clean the body text
            const cleanedBodyText = cleanBodyText($('body').html())
    
            // Take a screenshot of the mobile version and save it
            await page.setViewport({ width: 375, height: 812, isMobile: true }); // iPhone X viewport size
            await page.screenshot({
                path: path.join(pageDirectory, 'screenshot_mobile.jpg'),
                fullPage: true,
                quality: 80 // Adjust quality as needed, lower values mean higher compression
            });
        
            // Take a screenshot of the desktop version and save it
            await page.setViewport({ width: 1920, height: 1080 });
            await page.screenshot({
                path: path.join(pageDirectory, 'screenshot_desktop.jpg'),
                fullPage: true,
                quality: 80 // Adjust quality as needed, lower values mean higher compression
            });
    
        // Extract breadcrumbs
        const breadcrumbs = [];
        $('ul.breadcrumb > li').each((index, element) => {
            const crumb = $(element).text().trim();
            if (crumb) {
                breadcrumbs.push(crumb);
            }
        });

        const pageTitle = $('title').text().trim();

        // Create directory for page storage with the breadcrumb structure
        const pageDirectory = await createPageDirectory(baseUrl, url, pageTitle, breadcrumbs, parentDirectory);

        // Save the page content to a file
        const pageContentPath = path.join(pageDirectory, 'content.html');
        await fs.writeFile(pageContentPath, content);

        // Log success message
        console.log(`Page content saved: ${pageContentPath}`);

        // Extract and follow links on the page
        const links = $('a').map((index, element) => $(element).attr('href')).get();
        for (const link of links) {
            const absoluteLink = new URL(link, baseUrl).href;
            await crawlWebsite(absoluteLink, browser, baseUrl, robots, page, pageDirectory);
        }
    
        } catch (error) {
            console.error('Error scraping page:', error);
            await logError(`Error scraping page: ${error}`);
    
            // Retry scraping the page with exponential backoff if retryCount > 0
            if (retryCount > 0 && error.name === 'TimeoutError') {
                console.log(`Retrying scraping page: ${url} - Retry count: ${retryCount}`);
                await sleep(Math.pow(2, (3 - retryCount)) * 1000);
                await crawlWebsite(url, browser, baseUrl, robots, page, parentDirectory, retryCount - 1);
            } else {
                console.error('Unhandled error occurred:', error);
            }
        }
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function scrapePageWithRetry(url, page, baseUrl, retryCount = 3) {
        let pageDirectory;
        try {
            // Navigate to the URL
            console.log(`Navigating to ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    
            // Wait for a specific selector to appear on the page
            await page.waitForSelector('body');
    
            // Extract page content using Cheerio
            const content = await page.content();
            const $ = cheerio.load(content);
    
            // Clean the body text
            const cleanedBodyText = cleanBodyText($('body').html()); // <-- Corrected this line

            // Take a screenshot of the mobile version and save it
            await page.setViewport({ width: 375, height: 812, isMobile: true }); // iPhone X viewport size
            await page.screenshot({
                path: path.join(pageDirectory, 'screenshot_mobile.jpg'),
                fullPage: true,
                quality: 80 // Adjust quality as needed, lower values mean higher compression
            });
        
            // Take a screenshot of the desktop version and save it
            await page.setViewport({ width: 1920, height: 1080 });
            await page.screenshot({
                path: path.join(pageDirectory, 'screenshot_desktop.jpg'),
                fullPage: true,
                quality: 80 // Adjust quality as needed, lower values mean higher compression
            });
    
            // Extract breadcrumbs
            const breadcrumbs = [];
            $('ul.breadcrumb > li').each((index, element) => {
                const crumb = $(element).text().trim();
                if (crumb) {
                    breadcrumbs.push(crumb);
                }
            });
    
            const pageTitle = $('title').text().trim();
    
            // Create directory for page storage with the breadcrumb structure
            pageDirectory = await createPageDirectory(baseUrl, url, pageTitle, breadcrumbs);
    
        } catch (error) {
            console.error('Error scraping page:', error);
            await logError(`Error scraping page: ${error}`);
    
            // Retry scraping the page with exponential backoff if retryCount > 0
            if (retryCount > 0 && error.name === 'TimeoutError') { // Check the error name
                console.log(`Retrying scraping page: ${url} - Retry count: ${retryCount}`);
                await sleep(Math.pow(2, (3 - retryCount)) * 1000); // Exponential backoff
                await scrapePageWithRetry(url, page, baseUrl, retryCount - 1);
            } else {
                console.error('Unhandled error occurred:', error); // Log unhandled errors
            }
        }
    }

    function cleanBodyText(text) {
        // Remove code blocks, iframes, and CSS
        const cleanedText = text.replace(/<\s*script[^>]*>[\s\S]*?<\/script\s*>|<\s*style[^>]*>[\s\S]*?<\/style\s*>|<\s*iframe[^>]*>[\s\S]*?<\/iframe\s*>|<\s*[^>]*>/gi, '');
        // Split the remaining text into separate lines
        return cleanedText.trim().split(/\r?\n/).filter(line => line.trim() !== '');
    }

    async function createTrashDirectory() {
        try {
            await fs.mkdir(trashDirectory, { recursive: true });
            console.log('Trash directory created:', trashDirectory); // Debug log
        } catch (error) {
            console.error('Error creating trash directory:', error);
        }
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async function directoryExists(directoryPath) {
        try {
            await fs.access(directoryPath);
            return true;
        } catch (error) {
            return false;
        }
    }
    
    async function createPageDirectory(baseUrl, pageUrl, pageTitle, breadcrumbs, parentDirectory) {
        const parsedPageUrl = new URL(pageUrl);
        const relativePath = parsedPageUrl.pathname.substring(1);
        const sanitizedTitle = sanitizeDirectoryName(pageTitle || 'Untitled');
        const sanitizedBreadcrumbs = breadcrumbs.map(crumb => sanitizeDirectoryName(crumb));
        const directories = [parentDirectory, ...relativePath.split('/'), ...sanitizedBreadcrumbs, sanitizedTitle];
        const directoryPath = path.join(...directories);
        try {
            await createDirectoryAsync(directoryPath); // Ensure the directory exists
        } catch (error) {
            console.error('Error creating page directory:', error); // Log the error
            await logError(`Error creating page directory: ${error}`);
            throw error; // Throw the error to propagate it
        }
        return directoryPath; // Resolve the promise with the directory path
    }

    async function createDirectoryAsync(directoryPath) {
        console.log('Creating directory:', directoryPath); // Debug log
        try {
            await fs.mkdir(directoryPath, { recursive: true });
        } catch (mkdirError) {
            throw mkdirError;
        }
    }

    function sanitizeDirectoryName(directoryName) {
        return directoryName.replace(/[\/\\:*?"<>|]/g, '_'); // Replace invalid characters with underscores
    }

    // Add debug logs to the createDirectory function
    async function createDirectory(directoryPath) {
        console.log('Creating directory:', directoryPath); // Debug log
        try {
            const pathString = await directoryPath; // Resolve the promise to get the directory path
            await fs.mkdir(pathString, { recursive: true });
        } catch (mkdirError) {
            console.error('Error creating directory:', mkdirError); // Log the error
            throw mkdirError; // Throw the error to propagate it
        }
    }

    // Add the function for extracting background images
    async function extractBackgroundImages(page) {
        const backgroundImages = [];
        const styleTags = await page.$$eval('style', (styles) => styles.map((style) => style.innerHTML));
        styleTags.forEach((style) => {
            const regex = /url\(['"]?(.*?)['"]?\)/g;
            let match;
            while ((match = regex.exec(style))) {
                const imageUrl = match[1];
                // Check if the image URL ends with '.webp'
                if (imageUrl.toLowerCase().endsWith('.webp')) {
                    backgroundImages.push(imageUrl);
                }
            }
        });
        return backgroundImages;
    }

    async function extractCSSBackgroundImages(page) {
        const cssLinks = await page.$$eval('link[rel="stylesheet"]', (links) => links.map((link) => link.href));
        const backgroundImages = [];
    
        for (const cssLink of cssLinks) {
            try {
                const response = await axios.get(cssLink);
                const cssContent = response.data;
                const regex = /url\(['"]?(.*?)['"]?\)/g;
                let match;
                while ((match = regex.exec(cssContent))) {
                    const imageUrl = match[1];
                    // Check if the image URL ends with '.webp'
                    if (imageUrl.toLowerCase().endsWith('.webp')) {
                        backgroundImages.push(imageUrl);
                    }
                }
            } catch (error) {
                console.error('Error parsing CSS file:', error);
                await logError(`Error parsing CSS file: ${error}`);
            }
        }
    
        return backgroundImages;
    }
    
// Update the downloadMedia function to ensure files are saved in the correct directory
async function downloadMedia(url, directory, baseUrl) {
    console.log('Downloading media:', url);
    try {
        // Check if the URL starts with a protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            console.log(`Skipping invalid URL: ${url}`);
            return;
        }

        // Parse the URL
        const urlObj = new URL(url);

        // Check if it's an image
        if (!isImage(urlObj.pathname)) {
            console.log(`Skipping unsupported media type: ${url}`);
            return;
        }

        // Construct absolute URL for the media file
        const absoluteUrl = new URL(url, baseUrl).href;

        // Attempt to download the file
        const response = await axios.get(absoluteUrl, { responseType: 'arraybuffer', timeout: 60000 });

        // Check if the response status is 200
        if (response.status === 200) {
            const filename = path.basename(urlObj.pathname);
            const sanitizedFilename = sanitizeFilename(filename); // Sanitize the filename

            // Ensure that the directory exists
            await createDirectory(path.join(directory, 'media')); // Ensure 'media' directory is created

            // Specify the file path in the "media" directory
            const filePath = path.join(directory, 'media', sanitizedFilename);

            // Write the file content to disk
            await fs.writeFile(filePath, response.data);

            downloadMedia.downloadedFiles.add(url); // Add the URL to the downloadedFiles set
            console.log(`Downloaded media: ${url}`);
        } else {
            console.log(`Media not found (404): ${url}`);
        }
    } catch (error) {
        console.error(`Error downloading media ${url}:`, error);
        await logError(`Error downloading media: ${error}`);
        console.log(`Skipping media: ${url}`);
    }
}

// Add debug logs to the createDirectory function
async function createDirectory(directoryPath) {
    console.log('Creating directory:', directoryPath); // Debug log
    try {
        await fs.mkdir(directoryPath, { recursive: true });
    } catch (mkdirError) {
        throw mkdirError;
    }
}

    function isImage(url) {
        // Extract the file extension from the URL pathname
        const extension = path.extname(url).toLowerCase();
        // Check if the extension matches any image extensions
        return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(extension);
    }
    
    function isVideo(extension) {
        return ['.mp4', '.avi', '.mov', '.wmv', '.mkv', '.flv', '.webm'].includes(extension);
    }
    
    function isDocument(extension) {
        return ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'].includes(extension);
    }
    
    function isAudio(extension) {
        return ['.mp3', '.wav', '.ogg', '.aac', '.flac'].includes(extension);
    }
    
    function getFileType(extension) {
        if (isImage(extension)) return 'img';
        if (isVideo(extension)) return 'videos';
        if (isDocument(extension)) return 'docs';
        if (isAudio(extension)) return 'audio';
        return 'other';
    }

    function isVideo(extension) {
        return ['.mp4', '.avi', '.mov', '.wmv'].includes(extension);
    }

    async function compressAndSaveImage(imageData, filePath) {
        try {
            const compressedImageBuffer = await sharp(imageData)
                .jpeg({ quality: 80 }) // Adjust quality as needed
                .png({ compressionLevel: 9 }) // Adjust compression level as needed
                .webp({ quality: 80 }) // Adjust quality as needed
                .toBuffer();
            await fs.writeFile(filePath, compressedImageBuffer);
        } catch (error) {
            console.error('Error compressing and saving image:', error);
            await fs.writeFile(filePath, imageData); // Save the original image if compression fails
        }
    }

    function sanitizeFilename(filename) {
        return filename.replace(/[\/\\:*?"<>|]/g, '_'); // Replace invalid characters with underscores
    }

    downloadMedia.downloadedFiles = new Set(); // Initialize downloadedFiles set

    const blacklist = ['events', 'calendar']; // Add directories to exclude from crawling

    function generateSitemap(url) {
        fs.appendFile(sitemapPath, `<url><loc>${url}</loc></url>\n`);
    }

    function isValidUrl(url) {
        try {
            // Check if the URL has a valid format and includes both the protocol and the domain name
            const parsedUrl = new URL(url);
            return parsedUrl.protocol && parsedUrl.hostname;
        } catch (error) {
            return false;
        }
    }

    async function getRobotsContent(url) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            console.error(`Error fetching robots.txt content from ${url}:`, error);
            await logError(`Error fetching robots.txt content: ${error}`);
            return ''; // Return an empty string if there's an error
        }
    }

// Update the main function to handle errors and complete the crawling process
    async function main() {
        try {
            // Call function to create the trash directory
            await createTrashDirectory();

            const startUrl = mainUrl;
            const parsedUrl = new URL(startUrl);
            const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
            const browser = await puppeteer.launch(browserOptions);
            const page = await browser.newPage(); // Create a new page instance

            // Fetch robots.txt content
            const robotsContent = await getRobotsContent(robotsUrl);

            generateSitemap(startUrl);
            const pageDirectory = await createPageDirectory(baseUrl, startUrl, 'Home', []); // Initialize pageDirectory

            // Pass the 'page' variable to the 'crawlWebsite' function
            await crawlWebsite(startUrl, browser, baseUrl, robotsParser(robotsContent), page, pageDirectory); // Pass page here

            await browser.close();
        } catch (error) {
            console.error('Main function error:', error);
            await logError(`Main function error: ${error}`);
        }
    }
    
    main();
})();