import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import Product from "./models/Product.js";
import puppeteer from "puppeteer";
import NodeCache from "node-cache";

dotenv.config();
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static("public"));

const enableMongo = false;
if (enableMongo && process.env.MONGO_URL) {
  mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.log("Mongo connection failed:", err.message));
} else {
  console.warn("Skipping Mongo persistence (demo mode).");
}

const cache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour cache

const FLIPKART_LISTING_LINK_SELECTORS = [
  "div[data-id] a._1fQZEK",
  "div[data-id] a.s1Q9rs",
  "div._1AtVbE a._1fQZEK",
  "div._1AtVbE a.s1Q9rs",
  "div._13oc-S a",
  "div[data-id] a",
  "div._1AtVbE a"
];
const FLIPKART_CONTAINER_SELECTORS = ["div[data-id]", "div._1AtVbE", "div._13oc-S"];
const FLIPKART_LISTING_TITLE_SELECTORS = ["div._4rR01T", "a.s1Q9rs", "div.KzDlHZ", "div._2WkVRV"];
const FLIPKART_PRODUCT_TITLE_SELECTORS = ["span.B_NuCI", "span._35KyD6", "span.VU-ZEz"];
const FLIPKART_PRIMARY_PRICE_SELECTORS = [
  "div._30jeq3._16Jk6d",
  "div._25b18c",
  "div.Nx9bqj",
  "span.Nx9bqj"
];
const FLIPKART_PRICE_SELECTORS = [
  "div._30jeq3._1_WHN1",
  "div._30jeq3._16Jk6d",
  "div._30jeq3",
  "div._25b18c",
  "div.Nx9bqj",
  "div.hl05eU",
  "div.cN1yYO",
  "span.Nx9bqj",
  "div._2Tpdn3"
];
const FLIPKART_PRICE_SELECTOR_STRING = FLIPKART_PRICE_SELECTORS.join(", ");
const FLIPKART_LISTING_LINK_WAIT = ["div[data-id] a", "div._1AtVbE a", "div._13oc-S a"].join(", ");
const IGNORED_REQUEST_FAILURE_HOSTS = [
  "tatadigital.com",
  "bidswitch.net",
  "socdm.com",
  "casalemedia.com",
  "dmxleo.com",
  "adingo.jp",
  "360yield.com",
  "rlcdn.com",
  "media.net",
  "outbrain.com",
  "pubmatic.com",
  "rubiconproject.com",
  "smartadserver.com",
  "teads.tv",
  "clmbtech.com",
  "3lift.com",
  "1rx.io"
];

function parsePriceValue(text) {
  if (!text) return null;
  const sanitized = text.replace(/[^0-9.,]/g, "").replace(/,/g, "").trim();
  if (!sanitized) return null;
  const value = parseFloat(sanitized);
  return Number.isFinite(value) ? value : null;
}

function normalizeQueryText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeQueryText(text).split(/\s+/).filter(Boolean);
}

function titleMatchesQuery(title, query) {
  const titleTokens = new Set(tokenize(title));
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !titleTokens.size) return false;
  return queryTokens.every(token => titleTokens.has(token));
}

function buildUnavailableResult(store, query, reason = "Not available") {
  return {
    store,
    title: query,
    price: null,
    displayPrice: "Not available",
    link: null,
    unavailable: true,
    message: reason,
    approximate: false
  };
}

async function firstText(page, selectors) {
  for (const selector of selectors) {
    const value = await page.$eval(selector, el => el.innerText).catch(() => null);
    if (value) return value;
  }
  return null;
}

function resolveChromiumExecutable() {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : undefined;
}

async function launchBrowser() {
  const executablePath = resolveChromiumExecutable();
  const options = {
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  return await puppeteer.launch(options);
}

async function createSafePage(browser) {
  const page = await browser.newPage();

  // prevent crashes from inside Chromium
  page.on("error", err => {
    console.log("Page crashed:", err.message);
  });
  page.on("pageerror", err => {
    console.log("Page script error:", err.message);
  });
  page.on("requestfailed", req => {
    const failure = req.failure();
    if (failure && failure.errorText === "net::ERR_ABORTED") return;
    const url = req.url() || "";
    if (IGNORED_REQUEST_FAILURE_HOSTS.some(host => url.includes(host))) return;
    console.log("Request failed:", url, failure ? failure.errorText : "unknown");
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 720 });

  return page;
}

async function runWithPage(browser, fn) {
  const page = await createSafePage(browser);
  try {
    return await fn(page);
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.log("Failed closing page:", err.message);
    }
  }
}

async function fetchAmazon(browser, query) {
  try {
    return await runWithPage(browser, async page => {
      const searchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

      await page.waitForSelector("div.s-main-slot div[data-component-type='s-search-result']", { timeout: 15000 }).catch(()=>null);
      const listingChoice = await page
        .evaluate(searchTerm => {
          const normalize = str =>
            (str || "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          const tokenize = str => normalize(str).split(/\s+/).filter(Boolean);
          const matchesTerm = title => {
            const titleTokens = new Set(tokenize(title));
            const queryTokens = tokenize(searchTerm);
            if (!queryTokens.length || !titleTokens.size) return false;
            return queryTokens.every(token => titleTokens.has(token));
          };
          const results = Array.from(
            document.querySelectorAll("div.s-main-slot div[data-component-type='s-search-result']")
          );
          const mapped = results
            .map(result => {
              const anchor = result.querySelector("h2 a");
              if (!anchor) return null;
              const title = anchor.querySelector("span")?.innerText || null;
              return {
                href: anchor.href || anchor.getAttribute("href"),
                title
              };
            })
            .filter(item => item && item.href);
          const exact = mapped.find(item => matchesTerm(item.title));
          if (exact) return { ...exact, approximate: false };
          if (!mapped.length) return null;
          const fallback = mapped[0];
          return { ...fallback, approximate: true };
        }, query)
        .catch(() => null);

      let listingLink = listingChoice?.href || null;
      if (!listingLink) {
        const fallback = await page.$("div.s-main-slot a.a-link-normal.a-text-normal");
        if (fallback) {
          listingLink = await page.evaluate(a => a.href, fallback).catch(() => null);
        }
      }

      if (!listingLink) {
        console.log("Amazon listing selection failed for query:", query);
        return buildUnavailableResult("Amazon", query, "Not available");
      }

      console.log("Amazon listing pick:", {
        query,
        title: listingChoice?.title || null,
        link: listingLink,
        approximate: listingChoice?.approximate || !listingChoice?.title
      });
      await page.goto(listingLink, { waitUntil: "domcontentloaded", timeout: 15000 });

      await page.waitForTimeout(1000);
      const title = await page.$eval("#productTitle", el => el.innerText).catch(()=>null);
      const displayPrice = await page.$eval("#priceblock_ourprice", el => el.innerText).catch(()=>null) ||
                           await page.$eval("#priceblock_dealprice", el => el.innerText).catch(()=>null) ||
                           await page.$eval(".a-price .a-offscreen", el => el.innerText).catch(()=>null);
      const canonical = await page.evaluate(() => {
        const c = document.querySelector("link[rel='canonical']");
        return c ? c.href : location.href;
      }).catch(()=>null);
      const currentUrl = page.url();

      const price = parsePriceValue(displayPrice);
      if (!price) {
        console.log("Amazon scrape returned without price:", { query, title, displayPrice });
        return buildUnavailableResult("Amazon", query, "Not available");
      }

      const approximateListing = listingChoice
        ? (listingChoice.approximate || !titleMatchesQuery(listingChoice.title, query))
        : false;
      const payload = {
        store: "Amazon",
        title: title || query,
        price,
        displayPrice: displayPrice ? displayPrice.trim() : null,
        link: canonical || currentUrl,
        approximate: approximateListing || !titleMatchesQuery(title, query)
      };
      console.log("Amazon product scrape:", {
        query,
        title: payload.title,
        displayPrice: payload.displayPrice,
        link: payload.link
      });
      return payload;
    });
  } catch (err) {
    console.log("Amazon scrape failed:", err.message);
    return buildUnavailableResult("Amazon", query, "Not available");
  }
}

async function fetchFlipkart(browser, query) {
  try {
    return await runWithPage(browser, async page => {
      const searchUrl = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(FLIPKART_LISTING_LINK_WAIT, { timeout: 15000 }).catch(()=>null);

    const listingData = await page.evaluate(
      (linkSelectors, containerSelectors, titleSelectors, priceSelectors, searchTerm) => {
        const rupeePattern = /\u20B9\s*\d/;
        const normalize = str =>
          (str || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        const tokenize = str => normalize(str).split(/\s+/).filter(Boolean);
        const matchesTerm = title => {
          const titleTokens = new Set(tokenize(title));
          const queryTokens = tokenize(searchTerm);
          if (!queryTokens.length || !titleTokens.size) return false;
          return queryTokens.every(token => titleTokens.has(token));
        };
        const findWithin = (root, selectors) => {
          if (!root) return null;
          for (const selector of selectors) {
            const el = root.querySelector(selector);
            if (el) return el;
          }
          return null;
        };
        const extractPrice = root => {
          if (!root) return null;
          for (const selector of priceSelectors) {
            const el = root.querySelector(selector);
            if (el && rupeePattern.test(el.innerText || "")) {
              return el.innerText;
            }
          }
          const fallback = Array.from(root.querySelectorAll("div, span")).find(el =>
            rupeePattern.test((el.innerText || el.textContent || "").trim())
          );
          return fallback ? fallback.innerText || fallback.textContent : null;
        };

        const containerSelector = containerSelectors.join(", ");
        const resolveContainer = anchor =>
          anchor.closest(containerSelector) || anchor.parentElement || document.body;

        const collectAnchors = () => {
          const seen = new Set();
          const anchors = [];
          for (const selector of linkSelectors) {
            const list = document.querySelectorAll(selector);
            list.forEach(anchor => {
              if (!seen.has(anchor)) {
                seen.add(anchor);
                anchors.push(anchor);
              }
            });
          }
          return anchors;
        };

        const anchors = collectAnchors();
        if (!anchors.length) return null;

        const pickAnchor = () => {
          for (const anchor of anchors) {
            const containerCandidate = resolveContainer(anchor);
            const titleCandidate = containerCandidate
              ? findWithin(containerCandidate, titleSelectors)
              : null;
            const titleText = titleCandidate ? titleCandidate.innerText : anchor.innerText;
            if (matchesTerm(titleText)) {
              return { anchor, container: containerCandidate || document.body };
            }
          }
          return {
            anchor: anchors[0],
            container: resolveContainer(anchors[0]) || document.body
          };
        };

        const selection = pickAnchor();
        if (!selection) return null;

        const firstProductLink = selection.anchor;
        const container = selection.container || document.body;

        const titleEl = findWithin(container, titleSelectors);
        let priceFromSiblings = null;
        if (titleEl) {
          let block = titleEl;
          while (block && block.parentElement && block.parentElement !== container) {
            block = block.parentElement;
          }
          if (block) {
            let sibling = block.nextElementSibling;
            while (sibling) {
              priceFromSiblings = extractPrice(sibling);
              if (priceFromSiblings) break;
              sibling = sibling.nextElementSibling;
            }
          }
        }

        const displayPrice =
          extractPrice(container) ||
          priceFromSiblings ||
          extractPrice(document.body);
        const imageAlt = container.querySelector("img")?.getAttribute("alt");
        const href = firstProductLink.getAttribute("href") || firstProductLink.href;
        const offlineMessage = container.innerText.includes("Showing results for")
          ? "redirected to alternate results"
          : null;

        return {
          title: titleEl ? titleEl.innerText : imageAlt || null,
          displayPrice: displayPrice || null,
          link: href,
          offlineMessage,
          approximate: !matchesTerm(titleEl ? titleEl.innerText : imageAlt || "")
        };
      },
      FLIPKART_LISTING_LINK_SELECTORS,
      FLIPKART_CONTAINER_SELECTORS,
      FLIPKART_LISTING_TITLE_SELECTORS,
      FLIPKART_PRICE_SELECTORS,
      query
    ).catch(err => {
        console.log("Flipkart listing evaluate failed:", err.message);
        return null;
      });

      if (!listingData) {
        console.log("Flipkart listing scrape returned null for query:", query);
        return buildUnavailableResult("Flipkart", query, "Not available");
      }

      console.log("Flipkart listing scrape:", {
        query,
        title: listingData.title,
        displayPrice: listingData.displayPrice,
        link: listingData.link,
        offlineMessage: listingData.offlineMessage,
        approximate: listingData.approximate || false
      });

      let listingLink = listingData?.link || null;
      if (listingLink && listingLink.startsWith("/")) {
        listingLink = `https://www.flipkart.com${listingLink}`;
      }

    const listingPrice = parsePriceValue(listingData?.displayPrice || null);
    if (listingPrice && listingLink) {
      if (listingData?.offlineMessage) {
        console.log("Flipkart listing indicates alternate results:", listingData.offlineMessage);
      }
      return {
        store: "Flipkart",
        title: listingData?.title || query,
        price: listingPrice,
        displayPrice: listingData?.displayPrice ? listingData.displayPrice.trim() : null,
        link: listingLink,
        approximate: listingData?.approximate || !titleMatchesQuery(listingData?.title, query)
      };
      }

      if (!listingLink) {
        console.log("Flipkart listing did not provide a product link.");
        return buildUnavailableResult("Flipkart", query, "Not available");
      }

      try {
        await page.goto(listingLink, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (err) {
        console.log("Flipkart product navigation failed:", err.message);
        return buildUnavailableResult("Flipkart", query, "Not available");
      }

      await page.waitForSelector(FLIPKART_PRICE_SELECTOR_STRING, { timeout: 8000 }).catch(()=>null);
      await page.waitForTimeout(800);

    const title = await firstText(page, FLIPKART_PRODUCT_TITLE_SELECTORS);
    let displayPrice = await firstText(page, FLIPKART_PRIMARY_PRICE_SELECTORS);
    if (!displayPrice) {
      displayPrice = await page
        .evaluate((priceSelectors, titleSelectors) => {
          const rupeePattern = /\u20B9\s*\d/;
          const extractPrice = root => {
            if (!root) return null;
            for (const selector of priceSelectors) {
              const el = root.querySelector(selector);
              if (el && rupeePattern.test(el.innerText || "")) {
                return el.innerText;
              }
            }
            const fallback = Array.from(root.querySelectorAll("div, span")).find(node =>
              rupeePattern.test((node.innerText || node.textContent || "").trim())
            );
            return fallback ? fallback.innerText || fallback.textContent : null;
          };
          const findTitle = () => {
            for (const selector of titleSelectors) {
              const el = document.querySelector(selector);
              if (el) return el;
            }
            return null;
          };
          const titleEl = findTitle();
          const root = titleEl?.closest("div.cPHDOP") || document.querySelector("div.cPHDOP") || document.body;
          return extractPrice(root);
        }, FLIPKART_PRICE_SELECTORS, FLIPKART_PRODUCT_TITLE_SELECTORS)
        .catch(() => null);
      }
      const price = parsePriceValue(displayPrice);
      if (!price) {
        console.log("Flipkart product page missing price:", { query, displayPrice });
        return buildUnavailableResult("Flipkart", query, "Not available");
      }

      const link = await page.evaluate(() => location.href).catch(() => listingLink);

    console.log("Flipkart product page scrape:", {
      query,
      title,
      displayPrice,
      price,
      link
    });

    return {
      store: "Flipkart",
      title: title || listingData?.title || query,
      price,
      displayPrice: displayPrice ? displayPrice.trim() : null,
      link,
      approximate: listingData?.approximate || !titleMatchesQuery(title || listingData?.title, query)
    };
    });
  } catch (err) {
    console.log("Flipkart scrape failed:", err.message);
    return buildUnavailableResult("Flipkart", query, "Not available");
  }
}

async function fetchCroma(browser, query) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://www.croma.com/searchB?q=${encodedQuery}%3Arelevance&text=${encodedQuery}`;

  try {
    return await runWithPage(browser, async page => {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForSelector("li.product-item a[href*='/p/']", { timeout: 15000 }).catch(()=>null);

      const listingData = await page.evaluate(searchTerm => {
        const normalize = str =>
          (str || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        const tokenize = str => normalize(str).split(/\s+/).filter(Boolean);
        const matchesTerm = title => {
          const titleTokens = new Set(tokenize(title));
          const queryTokens = tokenize(searchTerm);
          if (!queryTokens.length || !titleTokens.size) return false;
          return queryTokens.every(token => titleTokens.has(token));
        };
        const cards = Array.from(document.querySelectorAll("li.product-item"));
        const cardData = card => {
          const anchor = card.querySelector("a[href*='/p/']");
          if (!anchor) return null;
          const titleEl =
            card.querySelector("h3") ||
            card.querySelector(".product-title") ||
            card.querySelector("[data-testid='product-title']");
          const priceEl =
            card.querySelector(".new-price") ||
            card.querySelector(".cp-price") ||
            card.querySelector("[data-testid='prod-price']") ||
            card.querySelector(".product-price");
          const titleText = titleEl ? titleEl.innerText : null;
          return {
            title: titleText,
            displayPrice: priceEl ? priceEl.innerText : null,
            link: anchor.href || anchor.getAttribute("href"),
            approximate: !matchesTerm(titleText)
          };
        };
        const dataList = cards.map(cardData).filter(Boolean);
        const exactMatch = dataList.find(item => matchesTerm(item.title));
        if (exactMatch) return exactMatch;
        if (!dataList.length) return null;
        const fallback = dataList[0];
        return { ...fallback, approximate: true };
      }, query).catch(() => null);

      if (!listingData) {
        console.log("Croma search returned no products for:", query);
        return buildUnavailableResult("Croma", query, "Not available");
      }

      let listingLink = listingData.link || null;
      if (listingLink && listingLink.startsWith("/")) {
        listingLink = `https://www.croma.com${listingLink}`;
      }

      console.log("Croma listing scrape:", {
        query,
        title: listingData.title,
        displayPrice: listingData.displayPrice,
        link: listingLink,
        approximate: listingData.approximate || false
      });

      const listingPrice = parsePriceValue(listingData.displayPrice || null);
      if (listingPrice && listingLink) {
        return {
          store: "Croma",
          title: listingData.title || query,
          price: listingPrice,
          displayPrice: listingData.displayPrice ? listingData.displayPrice.trim() : null,
          link: listingLink,
          approximate: listingData.approximate || !titleMatchesQuery(listingData.title, query)
        };
      }

      if (!listingLink) {
        console.log("Croma listing did not provide a product link.");
        return buildUnavailableResult("Croma", query, "Not available");
      }

      try {
        await page.goto(listingLink, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (err) {
        console.log("Croma product navigation failed:", err.message);
        return buildUnavailableResult("Croma", query, "Not available");
      }

      await page.waitForSelector(
        "span.price, .product-info-price .special-price .price, .new-price, .cp-price",
        { timeout: 12000 }
      ).catch(()=>null);
      await page.waitForTimeout(800);

      const title = await page.$eval("h1.page-title span", el => el.innerText).catch(()=>null) ||
                    await page.$eval("h1.product-name", el => el.innerText).catch(()=>null);
      const displayPrice = await page.$eval("span.price", el => el.innerText).catch(()=>null) ||
                           await page.$eval(".product-info-price .special-price .price", el => el.innerText).catch(()=>null) ||
                           await page.$eval(".new-price", el => el.innerText).catch(()=>null) ||
                           await page.$eval(".cp-price", el => el.innerText).catch(()=>null);
      const link = await page.evaluate(() => {
        const c = document.querySelector("link[rel='canonical']");
        return c ? c.href : location.href;
      }).catch(()=>null);

      const price = parsePriceValue(displayPrice);
      if (!price) {
        console.log("Croma product missing price:", { query, title, displayPrice });
        return buildUnavailableResult("Croma", query, "Not available");
      }

      const payload = {
        store: "Croma",
        title: title || listingData.title || query,
        price,
        displayPrice: displayPrice ? displayPrice.trim() : null,
        link: link || listingLink,
        approximate: listingData?.approximate || !titleMatchesQuery(title || listingData?.title, query)
      };

      console.log("Croma product page scrape:", {
        query,
        title: payload.title,
        displayPrice: payload.displayPrice,
        link: payload.link
      });

      return payload;
    });
  } catch (err) {
    console.log("Croma scrape failed:", err.message);
    return buildUnavailableResult("Croma", query, "Not available");
  }
}

async function fetchPricesLive(query) {
  const key = `prices:${query}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let browser;
  try {
    browser = await launchBrowser();
    const results = [];
    const a = await fetchAmazon(browser, query);
    if (a) results.push(a);
    const f = await fetchFlipkart(browser, query);
    if (f) results.push(f);
    const c = await fetchCroma(browser, query);
    if (c) results.push(c);

    await browser.close();
    cache.set(key, results);
    return results;
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch(e){}
    }
    return [];
  }
}

async function saveProductSearch(productName, finalPrices) {
  if (!process.env.MONGO_URL) return;
  if (mongoose.connection.readyState !== 1) return;

  try {
    const newProduct = new Product({
      name: productName,
      prices: finalPrices
    });
    await newProduct.save();
  } catch (err) {
    console.log("Failed to save product search:", err.message);
  }
}

app.post("/search", async (req, res) => {
  const { productName } = req.body;
  if (!productName) return res.status(400).json({ error: "productName required" });

  const prices = await fetchPricesLive(productName);

  if (!prices.length) {
    return res.status(502).json({ error: "Unable to fetch live prices right now. Please retry." });
  }

  await saveProductSearch(productName, prices);

  res.json({
    product: productName,
    prices
  });
});

app.listen(process.env.PORT || 5001, () =>
  console.log(`Server running at http://localhost:${process.env.PORT || 5001}`)
);
