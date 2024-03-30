const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const puppeteer = require('puppeteer');
const robotsParser = require('robots-parser');
const Bottleneck = require('bottleneck');
const sharp = require('sharp');

(async () => {
    const visitedUrls = new Set();
    const trashDirectory = path.join(__dirname, 'trash');
    const errorLogPath = path.join(__dirname, 'error.log');
    const sitemapPath = path.join(__dirname, 'sitemap.xml');
    const importantInfoPath = path.join(__dirname, 'important_information.txt');
    const userAgent = '7MMCrawler/1.0';
    const deadEndUrls = new Set();
    const mainUrl = 'https://www.mccort.org';
    const robotsUrl = mainUrl + '/robots.txt';
    const limiter = new Bottleneck({ maxConcurrent: 10, minTime: 1000 });
    const browserOptions = {
        timeout: 60000, // Increase the overall timeout to 60 seconds
        puppeteerOptions: {
            protocolTimeout: 90000, // Increase the protocol timeout to 90 seconds
            args: ['--start-maximized']
        }
    };

    async function logError(error) {
        await fs.appendFile(errorLogPath, `${new Date().toISOString()} - ${error}\n`);
    }

    async function scrapePage(url, page, baseUrl) {
        try {
            // Navigate to the URL and wait for page to stabilize
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Extract page content
            const content = await page.content();
            const $ = cheerio.load(content);
            
            // Extract page title
            const title = $('title').text().trim();
            
            // Extract breadcrumbs
            const breadcrumbs = [];
            $('ul.breadcrumb > li').each((index, element) => {
                const crumb = $(element).text().trim();
                if (crumb) {
                    breadcrumbs.push(crumb);
                }
            });
            
            // Create directory for page storage with the breadcrumb structure
            const pageDirectory = createPageDirectory(baseUrl, url, title, breadcrumbs);
    
            // Check if directory already exists, if yes, return
            if (await directoryExists(pageDirectory)) {
                console.log(`Directory already exists for ${url}`);
                return;
            }
            
            // Create parent directories if they do not exist
            await createDirectory(pageDirectory);
            
            // Extract important content such as headings and text
            const importantContent = $('body').find('a, abbr, address, article, aside, b, bdi, bdo, blockquote, button, caption, cite, code, data, datalist, dd, del, details, dfn, dialog, div, dl, dt, em, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, i, iframe, ins, kbd, label, legend, li, main, mark, menu, nav, noscript, object, optgroup, option, output, p, picture, pre, q, rp, rt, ruby, s, samp, section, select, small, source, span, strong, sub, summary, sup, table, tbody, td, template, tfoot, th, thead, time, tr, track, u, ul, var, video').map((index, element) => {
                return $(element).text().trim();
            }).get().join('\n');
            
            // Save important text content to a text file
            await fs.writeFile(path.join(pageDirectory, 'content.txt'), importantContent);
            
            // Save HTML source code to a file
            await fs.writeFile(path.join(pageDirectory, 'source.html'), content);
            
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
            
            // Download images
            const imageUrls = [];
            $('img').each((index, element) => {
                const imageUrl = $(element).attr('src');
                if (imageUrl) {
                    imageUrls.push(imageUrl);
                }
            });
            for (const imageUrl of imageUrls) {
                await downloadMedia(imageUrl, pageDirectory);
            }
            
            console.log(`Scraped content for ${url}`);
            
        } catch (error) {
            console.error('Error scraping page:', error);
            await logError(`Error scraping page: ${error}`);
        }
    }
    
    async function directoryExists(directoryPath) {
        try {
            await fs.access(directoryPath);
            return true;
        } catch (error) {
            return false;
        }
    }

    function createPageDirectory(baseUrl, pageUrl, pageTitle, breadcrumbs) {
        // Ensure all variables are properly defined and formatted
        const parsedBaseUrl = new URL(baseUrl);
        const baseUrlPathname = parsedBaseUrl.pathname.endsWith('/') ? parsedBaseUrl.pathname : parsedBaseUrl.pathname + '/';
        const parsedPageUrl = new URL(pageUrl);
        const relativePath = parsedPageUrl.pathname.startsWith(baseUrlPathname) ?
            parsedPageUrl.pathname.substring(baseUrlPathname.length) :
            parsedPageUrl.pathname.substring(1);
        const sanitizedTitle = sanitizeDirectoryName(pageTitle || 'Untitled');
        const sanitizedBreadcrumbs = breadcrumbs.map(crumb => sanitizeDirectoryName(crumb));
    
        // Logging variable values before calling path.join()
        console.log('__dirname:', __dirname);
        console.log('parsedPageUrl.hostname:', parsedPageUrl.hostname);
        console.log('relativePath:', relativePath);
        console.log('sanitizedTitle:', sanitizedTitle);
        console.log('sanitizedBreadcrumbs:', sanitizedBreadcrumbs);
    
        // Ensure all directory names are strings and properly formatted
        const directories = [
            __dirname,
            'pages',
            parsedPageUrl.hostname,
            ...relativePath.split('/'),
            sanitizedTitle,
            ...sanitizedBreadcrumbs
        ].map(dir => String(dir)); // Convert all directory names to strings
    
        // Join the directories to form the path
        return path.join(...directories);
    }

    function sanitizeDirectoryName(directoryName) {
        return directoryName.replace(/[\/\\:*?"<>|]/g, '_'); // Replace invalid characters with underscores
    }

    async function createDirectory(directoryPath) {
        try {
            await fs.mkdir(directoryPath, { recursive: true });
        } catch (mkdirError) {
            throw mkdirError;
        }
    }

    async function downloadMedia(url, directory) {
        try {
            if (downloadMedia.downloadedFiles.has(url)) {
                console.log(`Media already downloaded: ${url}`);
                return;
            }
            const urlObj = new URL(url);
            const response = await axios.get(urlObj.href, { responseType: 'arraybuffer' });
            if (response.status === 200) {
        // Determine file type
        const fileExtension = path.extname(url).toLowerCase();
        const fileType = getFileType(fileExtension);
        
        // Save the file in the appropriate directory based on file type
        let filePath;
        if (fileType === 'img') {
            const imgDirectory = path.join(directory, 'img');
            await createDirectory(imgDirectory);
            filePath = path.join(imgDirectory, sanitizeFilename(path.basename(url)));
            await compressAndSaveImage(response.data, filePath);
        } else if (fileType === 'videos') {
            const videosDirectory = path.join(directory, 'videos');
            await createDirectory(videosDirectory);
            filePath = path.join(videosDirectory, sanitizeFilename(path.basename(url)));
            await fs.writeFile(filePath, response.data);
        } else if (fileType === 'docs') {
            const docsDirectory = path.join(directory, 'docs');
            await createDirectory(docsDirectory);
            filePath = path.join(docsDirectory, sanitizeFilename(path.basename(url)));
            await fs.writeFile(filePath, response.data);
        } else if (fileType === 'audio') {
            const audioDirectory = path.join(directory, 'audio');
            await createDirectory(audioDirectory);
            filePath = path.join(audioDirectory, sanitizeFilename(path.basename(url)));
            await fs.writeFile(filePath, response.data);
        } else {
            const otherDirectory = path.join(directory, 'other');
            await createDirectory(otherDirectory);
            filePath = path.join(otherDirectory, sanitizeFilename(path.basename(url)));
            await fs.writeFile(filePath, response.data);
        }
                
                downloadMedia.downloadedFiles.add(url); // Add the URL to the downloadedFiles set
                console.log(`Downloaded media: ${url}`);
            } else {
                console.log(`Media not found (404): ${url}`);
            }
        } catch (error) {
            // Handle specific errors and ignore others
            if (error.message.includes('no such file or directory')) {
                console.log(`Error downloading media ${url}: File not found`);
            } else if (error instanceof TypeError && error.code === 'ERR_INVALID_URL') {
                console.log(`Error downloading media ${url}: Invalid URL`);
            } else {
                console.error(`Error downloading media ${url}:`, error);
                await logError(`Error downloading media: ${error}`);
                await fs.writeFile(path.join(trashDirectory, path.basename(url)), ''); // Move failed downloads to trash
                console.log(`Moved media to trash: ${url}`);
            }
        }
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

    async function crawlWebsite(url, browser, baseUrl, robots) {
        if (visitedUrls.has(url) || !url.startsWith(baseUrl)) {
            return;
        }
    
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(segment => segment); // Get path segments
    
        // Check if any path segment matches the blacklist
        if (pathSegments.some(segment => blacklist.includes(segment.toLowerCase()))) {
            console.log(`Skipping URL due to blacklist: ${url}`);
            return;
        }
    
        console.log('Scraping URL:', url);
        visitedUrls.add(url);
    
        try {
            const response = await axios.get(url);
            // Check if the response status is 404
            if (response.status === 404) {
                console.log(`Error crawling website: ${url} - 404 Not Found`);
                return; // Skip processing this URL
            }
    
            const page = await browser.newPage();
            await scrapePage(url, page, baseUrl); // Call the scrapePage function with the correct parameters
    
            const $ = cheerio.load(response.data);
            const absoluteLinks = [];
            $('a').each(async (index, element) => {
                const link = $(element).attr('href');
                if (link && typeof link === 'string' && !link.startsWith('javascript:') && !/\#.*$/.test(link)) {
                    const absoluteLink = new URL(link, url).href;
                    absoluteLinks.push(absoluteLink);
                }
            });
    
            if (absoluteLinks.length === 0) {
                deadEndUrls.add(url);
                return;
            }
            generateSitemap(url);
            for (const absoluteLink of absoluteLinks) {
                if (absoluteLink.startsWith(baseUrl) && !visitedUrls.has(absoluteLink) && robots.isAllowed(absoluteLink, userAgent)) {
                    await crawlWebsite(absoluteLink, browser, baseUrl, robots);
                }
            }
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`Error crawling website: ${url} - 404 Not Found`);
            } else {
                console.error('Error crawling website:', error);
                await logError(`Error crawling website: ${error}`);
            }
        }
    }

    // Function to determine if the URL points to an image
    function isImage(url) {
        // Extract the file extension from the URL pathname
        const extension = path.extname(url).toLowerCase();
        // Check if the extension matches any image extensions
        return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(extension);
    }

    // Function to determine if the file extension corresponds to a video file
    function isVideo(extension) {
        return ['.mp4', '.avi', '.mov', '.wmv', '.mkv', '.flv', '.webm'].includes(extension);
    }

    // Function to determine if the file extension corresponds to a document file
    function isDocument(extension) {
        return ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'].includes(extension);
    }

    // Function to determine if the file extension corresponds to an audio file
    function isAudio(extension) {
        return ['.mp3', '.wav', '.ogg', '.aac', '.flac'].includes(extension);
    }

    // Function to get the file type based on its extension
    function getFileType(extension) {
        if (isImage(extension)) return 'img';
        if (isVideo(extension)) return 'videos';
        if (isDocument(extension)) return 'docs';
        if (isAudio(extension)) return 'audio';
        return 'other';
    }

    // Function to compress and save an image
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

    // Function to sanitize a filename
    function sanitizeFilename(filename) {
        return filename.replace(/[\/\\:*?"<>|]/g, '_'); // Replace invalid characters with underscores
    }
    // Set to keep track of downloaded files
    downloadMedia.downloadedFiles = new Set();

    // Array of directories to exclude from crawling
    const blacklist = ['events', 'calendar'];

    function generateSitemap(url) {
        fs.appendFile(sitemapPath, `<url><loc>${url}</loc></url>\n`);
    }

    function createBreadcrumbDirectories(baseUrl, breadcrumbs) {
        const parsedUrl = new URL(baseUrl);
        const domain = parsedUrl.hostname;
        const sanitizedBreadcrumbs = breadcrumbs.map(crumb => sanitizeDirectoryName(crumb));
        const directories = [domain, ...sanitizedBreadcrumbs];
        return path.join(...directories);
    }

    async function main() {
        const startUrl = mainUrl;
        const parsedUrl = new URL(startUrl);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
        const browser = await puppeteer.launch(browserOptions);
        generateSitemap(startUrl);
        await crawlWebsite(startUrl, browser, baseUrl, robotsParser(robotsUrl, await fs.readFile('robots.txt', 'utf-8')));

        await browser.close();
    }

    main();
})();
