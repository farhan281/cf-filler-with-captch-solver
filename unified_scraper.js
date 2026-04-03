const puppeteer = require('puppeteer');
const fs = require('fs');

const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbxrirb17CXY4T1s_uvK-m9p29S-PrfIs8L4CZPCfVXCg8NwMZz0XMVs9scuKJiNhBFX/exec';
const CONFIG_FILE = 'config.json';
const PROGRESS_FILE = 'unified_progress.json';
const CSV_FILE = 'digital_marketing_data.csv';

let config = {};
let progress = { completed: [], currentIndex: 0, processedMapsUrls: new Set() };

function loadConfig() {
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        console.log(`📋 Loaded ${config.areas.length} cities and ${config.keywords.length} keywords`);
    } catch (error) {
        console.error('❌ Error loading config:', error.message);
        process.exit(1);
    }
}

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
            if (!progress.processedMapsUrls) {
                progress.processedMapsUrls = new Set();
            } else {
                progress.processedMapsUrls = new Set(progress.processedMapsUrls);
            }
            console.log(`📊 Resuming from search ${progress.currentIndex + 1}`);
            console.log(`🔄 Already processed ${progress.processedMapsUrls.size} unique companies`);
        }
        // Also load Maps URLs from existing CSV to prevent duplicates after restart
        if (fs.existsSync(CSV_FILE)) {
            const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').filter(Boolean);
            if (lines.length > 1) {
                const headers = lines[0].split(',');
                const mapsUrlIdx = headers.findIndex(h => h.toLowerCase().includes('maps url'));
                if (mapsUrlIdx >= 0) {
                    let loaded = 0;
                    for (let i = 1; i < lines.length; i++) {
                        const cols = lines[i].split(',');
                        const url = (cols[mapsUrlIdx] || '').replace(/^"|"$/g, '').trim();
                        if (url && url.startsWith('http')) {
                            progress.processedMapsUrls.add(url);
                            loaded++;
                        }
                    }
                    console.log(`📋 Loaded ${loaded} URLs from CSV to prevent duplicates`);
                }
            }
        }
    } catch (error) {
        console.log('Starting fresh scraping');
    }
}

function saveProgress() {
    const progressToSave = {
        ...progress,
        processedMapsUrls: Array.from(progress.processedMapsUrls)
    };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressToSave, null, 2));
}

function initCSV() {
    if (!fs.existsSync(CSV_FILE)) {
        const headers = 'Index,Area,Keyword,Name,Rating,Reviews,Address,Phone,Maps Website,Actual Website,Contact Form URL,Maps URL,All Emails,Email Count,Timestamp\n';
        fs.writeFileSync(CSV_FILE, headers);
        console.log('📄 CSV file created');
    }
}

async function extractEmails(page, website) {
    try {
        // Get the domain from the website URL
        const websiteDomain = new URL(website).hostname.replace('www.', '').toLowerCase();
        
        const emailData = await page.evaluate(() => {
            const content = document.body.innerText;
            const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
            const textEmails = content.match(emailRegex) || [];
            
            const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
            const mailtoEmails = mailtoLinks.map(link => {
                const href = link.href;
                return href.replace('mailto:', '').split('?')[0].split('&')[0];
            });
            
            const allLinks = Array.from(document.querySelectorAll('a'));
            const hrefEmails = [];
            allLinks.forEach(link => {
                const href = link.href || '';
                const emailMatch = href.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/g);
                if (emailMatch) hrefEmails.push(...emailMatch);
            });
            
            return [...textEmails, ...mailtoEmails, ...hrefEmails];
        });
        
        // Filter emails to only include those matching the website domain
        const domainEmails = emailData.filter(email => {
            const lower = email.toLowerCase();
            const emailDomain = email.split('@')[1]?.toLowerCase();
            
            // Skip invalid emails and common non-business emails
            if (!emailDomain || 
                lower.includes('noreply') || 
                lower.includes('no-reply') ||
                lower.includes('example.com') ||
                lower.includes('test.com') ||
                lower.includes('gmail.com') ||
                lower.includes('yahoo.com') ||
                lower.includes('hotmail.com') ||
                !email.includes('@') ||
                !email.includes('.')) {
                return false;
            }
            
            // Only include emails that match the website domain
            return emailDomain === websiteDomain || emailDomain === `www.${websiteDomain}`;
        });
        
        // Remove duplicates
        return [...new Set(domainEmails)];
    } catch (error) {
        console.log(`❌ Email extraction error: ${error.message}`);
        return [];
    }
}

async function scrapeWebsiteDetails(page, website) {
    try {
        // Skip Google ads and irrelevant sites
        const badPatterns = [
            'google.com/aclk',
            'googleadservices.com', 
            'appdevelopmentcompanies.co',
            'clutch.co',
            'yelp.com',
            'facebook.com',
            'linkedin.com'
        ];
        
        if (badPatterns.some(pattern => website.includes(pattern))) {
            console.log(`⏭️ Skipping ad/irrelevant site: ${website}`);
            return { emails: [], actualWebsite: '', contactFormUrl: '' };
        }
        
        console.log(`🌐 Visiting: ${website}`);
        await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 12000 });
        
        // Get actual website URL (after redirects) and look for canonical URL
        let actualWebsite = page.url();
        
        // Try to find the real company website from page content
        const realWebsite = await page.evaluate(() => {
            // Look for canonical URL
            const canonical = document.querySelector('link[rel="canonical"]');
            if (canonical && canonical.href) {
                return canonical.href;
            }
            
            // Look for company website in meta tags
            const ogUrl = document.querySelector('meta[property="og:url"]');
            if (ogUrl && ogUrl.content) {
                return ogUrl.content;
            }
            
            // Look for main domain in links (company logo, home link)
            const homeLinks = Array.from(document.querySelectorAll('a[href]'))
                .filter(link => {
                    const text = link.textContent?.toLowerCase() || '';
                    const href = link.href || '';
                    return (text.includes('home') || text.includes('logo') || 
                           link.className?.includes('logo') || link.id?.includes('logo')) &&
                           href.startsWith('http') && !href.includes('google');
                })
                .map(link => link.href)[0];
            
            if (homeLinks) {
                return homeLinks;
            }
            
            // Extract base domain from current URL
            try {
                const url = new URL(window.location.href);
                return `${url.protocol}//${url.hostname}`;
            } catch (e) {
                return window.location.href;
            }
        });
        
        // Use the real website if found, otherwise use current URL
        if (realWebsite && realWebsite !== actualWebsite) {
            actualWebsite = realWebsite;
            console.log(`🔍 Found real website: ${actualWebsite}`);
        }
        
        // Extract emails from main page
        let emails = await extractEmails(page, actualWebsite);
        console.log(`📧 Main page emails: ${emails.length}`);
        
        // Find contact form and contact page URLs
        const contactInfo = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            let contactFormUrl = '';
            const contactLinks = [];
            
            links.forEach(link => {
                const text = link.textContent?.toLowerCase() || '';
                const href = link.href?.toLowerCase() || '';
                
                // Look for contact form
                if ((text.includes('contact') && (text.includes('form') || text.includes('us'))) ||
                    href.includes('contact') || href.includes('get-in-touch')) {
                    if (!contactFormUrl && link.href && link.href.startsWith('http')) {
                        contactFormUrl = link.href;
                    }
                    if (link.href && link.href.startsWith('http')) {
                        contactLinks.push(link.href);
                    }
                }
                
                // Also look for about, team pages
                if ((text.includes('about') || text.includes('team') || text.includes('company')) &&
                    link.href && link.href.startsWith('http')) {
                    contactLinks.push(link.href);
                }
            });
            
            return { contactFormUrl, contactLinks: [...new Set(contactLinks)] };
        });
        
        console.log(`📋 Contact form URL: ${contactInfo.contactFormUrl}`);
        console.log(`📧 Found ${contactInfo.contactLinks.length} contact-related links`);
        
        // If no emails on main page, check contact pages
        if (emails.length === 0 && contactInfo.contactLinks.length > 0) {
            for (const contactLink of contactInfo.contactLinks.slice(0, 3)) {
                try {
                    console.log(`📧 Checking contact page: ${contactLink}`);
                    await page.goto(contactLink, { waitUntil: 'domcontentloaded', timeout: 8000 });
                    
                    // Extract emails including mailto links
                    const contactEmails = await page.evaluate(() => {
                        const content = document.body.innerText;
                        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
                        const textEmails = content.match(emailRegex) || [];
                        
                        // Specifically look for mailto links
                        const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
                        const mailtoEmails = mailtoLinks.map(link => {
                            const href = link.href;
                            return href.replace('mailto:', '').split('?')[0].split('&')[0];
                        });
                        
                        return [...textEmails, ...mailtoEmails];
                    });
                    
                    console.log(`📧 Contact page emails: ${contactEmails.length}`);
                    emails.push(...contactEmails);
                    if (emails.length > 0) break;
                } catch (error) {
                    console.log(`❌ Error on contact page: ${error.message}`);
                    continue;
                }
            }
        }
        
        // Filter emails to match domain
        const websiteDomain = new URL(actualWebsite).hostname.replace('www.', '').toLowerCase();
        const domainEmails = emails.filter(email => {
            const lower = email.toLowerCase();
            const emailDomain = email.split('@')[1]?.toLowerCase();
            
            if (!emailDomain || 
                lower.includes('noreply') || 
                lower.includes('no-reply') ||
                lower.includes('example.com') ||
                lower.includes('test.com') ||
                lower.includes('gmail.com') ||
                lower.includes('yahoo.com') ||
                lower.includes('hotmail.com')) {
                return false;
            }
            
            return emailDomain === websiteDomain || emailDomain === `www.${websiteDomain}`;
        });
        
        const uniqueEmails = [...new Set(domainEmails)];
        console.log(`✅ Total unique emails found: ${uniqueEmails.length}`);
        
        return {
            emails: uniqueEmails,
            actualWebsite: actualWebsite,
            contactFormUrl: contactInfo.contactFormUrl
        };
    } catch (error) {
        console.log(`❌ Error scraping ${website}: ${error.message}`);
        return { emails: [], actualWebsite: '', contactFormUrl: '' };
    }
}

async function sendToSheets(data) {
    try {
        const response = await fetch(GOOGLE_SHEETS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'map', rows: [data] })
        });
        if (response.ok) return true;
        return false;
    } catch (error) {
        return false;
    }
}

function saveToCSV(data) {
    const csvRow = data.map(field => {
        const str = String(field ?? '');
        // Only wrap in quotes if field contains comma, newline, or double quote
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }).join(',') + '\n';
    fs.appendFileSync(CSV_FILE, csvRow);
}

async function scrapeUnified() {
    console.log('🚀 Starting unified Salesforce scraper...');
    
    loadConfig();
    loadProgress();
    initCSV();
    
    const searches = [];
    config.areas.forEach(city => {
        config.keywords.forEach(keyword => {
            searches.push({ city, keyword });
        });
    });
    
    console.log(`📊 Total searches: ${searches.length}`);
    console.log(`📊 Remaining: ${searches.length - progress.currentIndex}`);
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    let totalCompanies = 0;
    let totalEmails = 0;
    let globalIndex = 1; // Global counter across all searches
    
    try {
        for (let i = progress.currentIndex; i < searches.length; i++) {
            const { city, keyword } = searches[i];
            const searchKey = `${city}-${keyword}`;
            
            if (progress.completed.includes(searchKey)) {
                continue;
            }
            
            console.log(`\n🔍 [${i + 1}/${searches.length}] ${city} - ${keyword}`);
            
            try {
                // Go to Google Maps and perform search
                await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 1000));
                
                // Find and click search box
                const searchBox = await page.waitForSelector('input.UGojuc, input[name="q"], input[id="UGojuc"]', { timeout: 10000 });
                await searchBox.click();
                
                // Clear any existing text and type search query
                await searchBox.evaluate(el => el.value = '');
                const searchQuery = `${keyword} ${city}`;
                await searchBox.type(searchQuery, { delay: 100 });
                
                // Press Enter or click search button
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 3000));
                
                // Wait for results to load
                await page.waitForSelector('div[role="main"]', { timeout: 10000 });
                await new Promise(r => setTimeout(r, 1500));
                
                // Scroll to load all results
                console.log('📜 Scrolling to load all results...');
                let previousCount = 0;
                let currentCount = 0;
                let scrollAttempts = 0;
                let noChangeCount = 0;
                const maxScrolls = 20;
                const maxNoChange = 4;
                
                // First, get initial count
                currentCount = await page.evaluate(() => {
                    return document.querySelectorAll('div[role="article"]').length;
                });
                console.log(`📊 Initial results: ${currentCount}`);
                
                do {
                    previousCount = currentCount;
                    
                    // Try multiple scroll strategies
                    await page.evaluate(() => {
                        // Strategy 1: Scroll the main results container
                        const containers = [
                            document.querySelector('div[role="main"]'),
                            document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd'),
                            document.querySelector('[aria-label*="Results"]'),
                            document.querySelector('.e07Vkf.kA9KIf')
                        ];
                        
                        containers.forEach(container => {
                            if (container) {
                                container.scrollTop = container.scrollHeight;
                            }
                        });
                        
                        // Strategy 2: Scroll to the last visible result
                        const articles = document.querySelectorAll('div[role="article"]');
                        if (articles.length > 0) {
                            const lastArticle = articles[articles.length - 1];
                            lastArticle.scrollIntoView({ behavior: 'smooth', block: 'end' });
                        }
                        
                        // Strategy 3: Page scroll as backup
                        window.scrollTo(0, document.body.scrollHeight);
                    });
                    
                    // Wait for loading
                    await new Promise(r => setTimeout(r, 2500));
                    
                    // Trigger more loading by pressing Page Down
                    await page.keyboard.press('PageDown');
                    await new Promise(r => setTimeout(r, 1000));
                    
                    // Count current results
                    currentCount = await page.evaluate(() => {
                        return document.querySelectorAll('div[role="article"]').length;
                    });
                    
                    console.log(`📊 Results: ${currentCount} (was ${previousCount})`);
                    
                    if (currentCount === previousCount) {
                        noChangeCount++;
                        console.log(`⏳ No new results (${noChangeCount}/${maxNoChange})`);
                    } else {
                        noChangeCount = 0;
                        console.log(`✅ Found ${currentCount - previousCount} new results`);
                    }
                    
                    scrollAttempts++;
                    
                } while (scrollAttempts < maxScrolls && noChangeCount < maxNoChange);
                
                console.log(`✅ Scrolling complete. Final count: ${currentCount}`);
                await new Promise(r => setTimeout(r, 1000));
                
                const companies = await page.evaluate(() => {
                    const results = [];
                    
                    // Look for business listings with role="article"
                    const listings = document.querySelectorAll('div[role="article"]');
                    
                    listings.forEach((listing, index) => {
                        try {
                            // Get business name from qBF1Pd class
                            const nameEl = listing.querySelector('.qBF1Pd.fontHeadlineSmall');
                            
                            if (nameEl && nameEl.textContent && nameEl.textContent.trim()) {
                                const name = nameEl.textContent.trim();
                                
                                // Skip first 2 results (usually ads/irrelevant)
                                if (index < 2) {
                                    return;
                                }
                                
                                // Get rating from MW4etd class
                                const ratingEl = listing.querySelector('.MW4etd');
                                const rating = ratingEl?.textContent?.trim() || '';
                                
                                // Get reviews from UY7F9 class
                                const reviewsEl = listing.querySelector('.UY7F9');
                                const reviews = reviewsEl?.textContent?.replace(/[()]/g, '').trim() || '';
                                
                                // Get address from multiple possible selectors
                                let address = '';
                                const addressSelectors = [
                                    '.Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    '.Io6YTe',
                                    '.W4Efsd'
                                ];
                                
                                for (const selector of addressSelectors) {
                                    const addressEl = listing.querySelector(selector);
                                    if (addressEl && addressEl.textContent) {
                                        const text = addressEl.textContent.trim();
                                        // Check if it looks like an address
                                        if (text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Street|Avenue|Boulevard|Drive|Road)/i) ||
                                            text.includes(',') && text.length > 10) {
                                            address = text;
                                            break;
                                        }
                                    }
                                }
                                
                                // Fallback: look in W4Efsd spans for address-like content
                                if (!address) {
                                    const addressSpans = listing.querySelectorAll('.W4Efsd span');
                                    addressSpans.forEach(span => {
                                        const text = span.textContent?.trim();
                                        if (text && !text.includes('·') && !text.includes('Closed') && !text.includes('Open') && !text.includes('+1')) {
                                            if (text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln)/i)) {
                                                address = text;
                                            }
                                        }
                                    });
                                }
                                
                                // Get phone from UsdlK class
                                const phoneEl = listing.querySelector('.UsdlK');
                                const phone = phoneEl?.textContent?.trim() || '';
                                
                                // Get website from lcr4fd link with data-value="Website"
                                const websiteEl = listing.querySelector('a.lcr4fd[data-value="Website"]');
                                let website = '';
                                if (websiteEl && websiteEl.href) {
                                    website = websiteEl.href;
                                    // Clean up the website URL if it's a redirect
                                    if (website.includes('google.com/url?')) {
                                        const urlParams = new URLSearchParams(website.split('?')[1]);
                                        website = urlParams.get('url') || urlParams.get('q') || website;
                                    }
                                    
                                    // Filter out Google ads and irrelevant sites
                                    const badPatterns = [
                                        'google.com/aclk',
                                        'googleadservices.com',
                                        'appdevelopmentcompanies.co',
                                        'clutch.co',
                                        'yelp.com',
                                        'facebook.com',
                                        'linkedin.com',
                                        'twitter.com',
                                        'instagram.com'
                                    ];
                                    
                                    if (badPatterns.some(pattern => website.includes(pattern))) {
                                        website = ''; // Clear bad websites
                                    }
                                }
                                
                                // Get maps URL from hfpxzc link
                                const mapsEl = listing.querySelector('a.hfpxzc');
                                let mapsUrl = '';
                                if (mapsEl && mapsEl.href && mapsEl.href.includes('maps')) {
                                    mapsUrl = mapsEl.href;
                                }
                                
                                results.push({
                                    name, rating, reviews, address, phone, website, mapsUrl
                                });
                            }
                        } catch (error) {
                            // Skip invalid listings
                        }
                    });
                    
                    return results;
                });
                
                console.log(`📍 Found ${companies.length} companies`);
                
                // Debug: Show first company details
                if (companies.length > 0) {
                    console.log('🔍 Sample company:', {
                        name: companies[0].name,
                        website: companies[0].website,
                        mapsUrl: companies[0].mapsUrl
                    });
                }
                
                // Process each company by clicking to get full details
                for (let j = 0; j < companies.length; j++) {
                    const company = companies[j];
                    let fullCompanyData = { ...company };
                    
                    try {
                        console.log(`📋 [${globalIndex}] Processing: ${company.name}`);
                        
                        // Go back to search results if not on first company
                        if (j > 0) {
                            await page.goBack();
                            await new Promise(r => setTimeout(r, 1500));
                        }
                        
                        // Click on the company to open side panel
                        const clicked = await page.evaluate((index) => {
                            const articles = document.querySelectorAll('div[role="article"]');
                            if (articles[index]) {
                                // Try multiple click strategies
                                const link = articles[index].querySelector('a.hfpxzc');
                                const nameElement = articles[index].querySelector('.qBF1Pd.fontHeadlineSmall');
                                
                                if (link) {
                                    // Strategy 1: Direct click on link
                                    link.click();
                                    return true;
                                } else if (nameElement) {
                                    // Strategy 2: Click on name element
                                    nameElement.click();
                                    return true;
                                } else {
                                    // Strategy 3: Click on the article itself
                                    articles[index].click();
                                    return true;
                                }
                            }
                            return false;
                        }, j);
                        
                        // Alternative: Navigate directly to Maps URL if available
                        if (!clicked && company.mapsUrl) {
                            try {
                                console.log(`🔗 Navigating directly to: ${company.name}`);
                                await page.goto(company.mapsUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
                                await new Promise(r => setTimeout(r, 2000));
                            } catch (error) {
                                console.log(`❌ Failed to navigate to ${company.name}: ${error.message}`);
                                globalIndex++;
                                continue;
                            }
                        } else if (!clicked) {
                            console.log(`⚠️ Could not access ${company.name}`);
                            globalIndex++;
                            continue;
                        }
                        
                        // Wait for side panel to load and check if it opened
                        await new Promise(r => setTimeout(r, 2500));
                        
                        // Verify side panel loaded by checking for detailed content
                        const sidePanelLoaded = await page.evaluate(() => {
                            return document.querySelector('.Io6YTe.fontBodyMedium.kR99db.fdkmkc') !== null ||
                                   document.querySelector('[data-value="Address"]') !== null ||
                                   document.querySelector('.rogA2c') !== null;
                        });
                        
                        if (!sidePanelLoaded) {
                            console.log(`⚠️ Side panel not loaded for ${company.name}, using basic data`);
                        } else {
                            // Extract detailed information from side panel
                            const detailedInfo = await page.evaluate(() => {
                                let address = '';
                                let phone = '';
                                let website = '';
                                
                                // Multiple selectors for address in side panel
                                const addressSelectors = [
                                    '.Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    '[data-item-id="address"] .Io6YTe',
                                    'button[data-item-id="address"] .Io6YTe',
                                    '.rogA2c .Io6YTe.fontBodyMedium.kR99db.fdkmkc'
                                ];
                                
                                for (const selector of addressSelectors) {
                                    const el = document.querySelector(selector);
                                    if (el && el.textContent) {
                                        const text = el.textContent.trim();
                                        // Check if it looks like a full address
                                        if (text.length > 10 && (text.includes(',') || text.match(/\d+.*(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Street|Avenue|Boulevard|Drive|Road)/i))) {
                                            address = text;
                                            break;
                                        }
                                    }
                                }
                                
                                // Phone selectors - look in all AeaXub divs
                                const phoneSelectors = [
                                    'button[data-item-id*="phone"] .Io6YTe',
                                    '.rogA2c .Io6YTe.fontBodyMedium.kR99db.fdkmkc',
                                    'div[role="img"][aria-label*="Phone"] + .rogA2c .Io6YTe',
                                    '.AeaXub .Io6YTe'
                                ];
                                
                                // Check all AeaXub containers for phone
                                const aeaXubDivs = document.querySelectorAll('.AeaXub');
                                for (const div of aeaXubDivs) {
                                    const ioText = div.querySelector('.Io6YTe');
                                    if (ioText && ioText.textContent) {
                                        const text = ioText.textContent.trim();
                                        // Check if it looks like a phone number
                                        if (text.match(/^[\+\d][\d\s\-\(\)]{8,}$/)) {
                                            phone = text;
                                            break;
                                        }
                                    }
                                }
                                
                                // Website selectors - look in all AeaXub divs
                                const aeaXubDivsForWebsite = document.querySelectorAll('.AeaXub');
                                for (const div of aeaXubDivsForWebsite) {
                                    const ioText = div.querySelector('.Io6YTe');
                                    if (ioText && ioText.textContent) {
                                        const text = ioText.textContent.trim();
                                        // Check if it looks like a website domain
                                        if (text.match(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/) && 
                                            !text.includes(' ') && 
                                            !text.match(/^[\+\d]/) &&
                                            !text.includes(',')) {
                                            website = 'https://' + text;
                                            break;
                                        }
                                    }
                                }
                                
                                // Fallback: look for website in links
                                if (!website) {
                                    const websiteSelectors = [
                                        'a[data-value="Website"]',
                                        'a[data-item-id="authority"]',
                                        '.rogA2c a[href^="http"]'
                                    ];
                                    
                                    for (const selector of websiteSelectors) {
                                        const el = document.querySelector(selector);
                                        if (el && el.href && el.href.startsWith('http')) {
                                            website = el.href;
                                            break;
                                        }
                                    }
                                }
                                
                                return { address, phone, website };
                            });
                            
                            // Update company data with detailed info
                            if (detailedInfo.address) fullCompanyData.address = detailedInfo.address;
                            if (detailedInfo.phone) fullCompanyData.phone = detailedInfo.phone;
                            if (detailedInfo.website) fullCompanyData.website = detailedInfo.website;
                            
                            console.log(`✅ Updated: ${fullCompanyData.name} - ${fullCompanyData.address}`);
                        }
                        
                    } catch (error) {
                        console.log(`❌ Error processing ${company.name}: ${error.message}`);
                        // Go back to search results on error
                        try {
                            await page.goBack();
                            await new Promise(r => setTimeout(r, 1500));
                        } catch (e) {
                            console.log('Could not go back, continuing...');
                        }
                    }
                    
                    // Skip if Maps URL already processed (duplicate prevention)
                    if (fullCompanyData.mapsUrl && progress.processedMapsUrls.has(fullCompanyData.mapsUrl)) {
                        console.log(`⏭️ Skipping duplicate Maps URL: ${fullCompanyData.name}`);
                        globalIndex++;
                        continue;
                    }
                    
                    let emails = [];
                    let emailCount = 0;
                    
                    if (fullCompanyData.website && fullCompanyData.website.startsWith('http') && fullCompanyData.website.length > 10) {
                        console.log(`🌐 Checking website details for: ${fullCompanyData.name}`);
                        const websiteDetails = await scrapeWebsiteDetails(page, fullCompanyData.website);
                        
                        emails = websiteDetails.emails;
                        emailCount = emails.length;
                        
                        if (emails.length > 0) {
                            console.log(`✅ Found ${emails.length} emails: ${emails.join('; ')}`);
                            totalEmails += emails.length;
                        }
                        
                        const unifiedData = [
                            globalIndex,
                            city,
                            keyword,
                            fullCompanyData.name,
                            fullCompanyData.rating,
                            fullCompanyData.reviews,
                            fullCompanyData.address,
                            fullCompanyData.phone,
                            fullCompanyData.website, // Maps website
                            websiteDetails.actualWebsite, // Actual website after redirects
                            websiteDetails.contactFormUrl, // Contact form URL
                            fullCompanyData.mapsUrl,
                            emails.join('; '),
                            emailCount,
                            new Date().toISOString()
                        ];
                        
                        saveToCSV(unifiedData);
                        await sendToSheets(unifiedData);
                    } else {
                        console.log(`⏭️ No valid website for: ${fullCompanyData.name}`);
                        
                        const unifiedData = [
                            globalIndex,
                            city,
                            keyword,
                            fullCompanyData.name,
                            fullCompanyData.rating,
                            fullCompanyData.reviews,
                            fullCompanyData.address,
                            fullCompanyData.phone,
                            fullCompanyData.website,
                            '', // No actual website
                            '', // No contact form
                            fullCompanyData.mapsUrl,
                            '',
                            0,
                            new Date().toISOString()
                        ];
                        
                        saveToCSV(unifiedData);
                        await sendToSheets(unifiedData);
                    }
                    
                    // Mark Maps URL as processed immediately to prevent duplicates
                    if (fullCompanyData.mapsUrl) {
                        progress.processedMapsUrls.add(fullCompanyData.mapsUrl);
                        saveProgress(); // Save immediately after marking as processed
                    }
                    
                    globalIndex++; // Increment global counter
                    await new Promise(r => setTimeout(r, 500));
                }
                
                totalCompanies += companies.length;
                progress.completed.push(searchKey);
                progress.currentIndex = i;
                saveProgress();
                
                console.log(`✅ Completed: ${companies.length} companies, ${totalEmails} total emails`);
                
            } catch (error) {
                console.log(`❌ Error in search: ${error.message}`);
            }
            
            await new Promise(r => setTimeout(r, 2000));
        }
        
    } finally {
        await browser.close();
        console.log(`\n🎉 Scraping completed!`);
        console.log(`📊 Total companies: ${totalCompanies}`);
        console.log(`📧 Total emails: ${totalEmails}`);
        console.log(`📄 Data saved to: ${CSV_FILE}`);
    }
}

async function runWithRestart() {
    while (true) {
        try {
            await scrapeUnified();
            console.log('✅ Scraping completed successfully');
            break;
        } catch (error) {
            console.error('❌ Scraper error:', error.message);
            console.log('⏰ Waiting 5 minutes before restart...');
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
            console.log('🔄 Restarting scraper...');
        }
    }
}

if (require.main === module) {
    runWithRestart().catch(console.error);
}