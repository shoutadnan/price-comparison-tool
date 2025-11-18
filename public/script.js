const STORE_LOGOS = {
  Amazon: "amazon-logo.svg",
  Flipkart: "flipkart-logo.svg",
  Croma: "croma-logo.svg"
};

const productInput = document.getElementById("productInput");
const searchButton = document.getElementById("searchButton");
const resultEl = document.getElementById("result");
const statusBox = document.getElementById("status");
const statusMessage = document.getElementById("statusMessage");

const updateStatus = (message, { loading = false, show = true } = {}) => {
  if (!show) {
    statusBox.classList.add("hidden");
    statusBox.classList.remove("loading");
    statusMessage.textContent = "";
    return;
  }
  statusBox.classList.remove("hidden");
  statusBox.classList.toggle("loading", loading);
  statusMessage.textContent = message;
};

const loadingMessages = [
  "🔍 Checking Amazon for the best offers...",
  "🛒 Scanning Flipkart shelves...",
  "🏬 Tapping into Croma's live inventory..."
];
let loadingMessageTimer = null;
let loadingMessageIndex = 0;

const startLoadingMessages = () => {
  loadingMessageIndex = 0;
  const cycle = () => {
    const message = loadingMessages[loadingMessageIndex % loadingMessages.length];
    loadingMessageIndex += 1;
    updateStatus(message, { loading: true, show: true });
  };
  cycle();
  loadingMessageTimer = setInterval(cycle, 1800);
};

const stopLoadingMessages = () => {
  if (loadingMessageTimer) {
    clearInterval(loadingMessageTimer);
    loadingMessageTimer = null;
  }
};

const formatTimestamp = () => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  return formatter.format(new Date());
};

productInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchPrice();
  }
});

async function searchPrice() {
  const productName = productInput.value.trim();
  if (!productName) {
    updateStatus("Please enter a product name to search.", { loading: false, show: true });
    resultEl.innerHTML = "";
    return;
  }

  resultEl.innerHTML = "";
  startLoadingMessages();
  searchButton.disabled = true;
  productInput.disabled = true;

  try {
    const response = await fetch("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productName })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Unable to fetch prices right now.");
    }

    const data = await response.json();

    if (!data.prices || !data.prices.length) {
      updateStatus("No live prices were returned. Please try a different query.", { loading: false });
      return;
    }

    let html = `<div class="results-header"><span>Live prices for</span> <strong>${data.product}</strong></div>`;
    const bestPrice = data.prices
      .filter(p => !p.unavailable && p.price != null)
      .reduce((min, current) => {
        if (min == null) return current.price;
        return current.price < min ? current.price : min;
      }, null);
    data.prices.forEach(p => {
      const isUnavailable = Boolean(p.unavailable || p.price == null);
      const isBest = !isUnavailable && bestPrice != null && p.price === bestPrice;
      const displayPrice = p.displayPrice
        ? p.displayPrice
        : isUnavailable
          ? "Not available"
          : `₹${p.price}`;
      const availabilityNote = isUnavailable
        ? `<p class="unavailable-note">${p.message || "Not available"}</p>`
        : "";
      const logoPath = STORE_LOGOS[p.store] ? `./${STORE_LOGOS[p.store]}` : null;
      const logoMarkup = logoPath
        ? `<div class="store-header">
              <img src="${logoPath}" alt="${p.store} logo">
              <span>${p.store}</span>
           </div>`
        : `<h3>${p.store}</h3>`;
      const linkMarkup = p.link
        ? `<a class="store-link" href="${p.link}" target="_blank" rel="noopener noreferrer">Visit Store</a>`
        : `<span class="muted">Link not available</span>`;
      const approxNote = p.approximate && !isUnavailable
        ? `<p class="approx-note"><em>* Product may vary from your exact search.</em></p>`
        : "";

      html += `
        <div class="card${isUnavailable ? " unavailable" : ""}">
          ${logoMarkup}
          <div class="card-body">
            <p>${p.title ? p.title : ""}</p>
          </div>
          <div class="card-price-block">
            <p class="price-label${isBest ? " best-price" : ""}">Price: ${displayPrice}</p>
            ${availabilityNote}
            ${approxNote}
          </div>
          ${linkMarkup}
        </div>
      `;
    });

    resultEl.innerHTML = html;
    stopLoadingMessages();
    updateStatus(`✨ Fresh prices fetched ${formatTimestamp()}`, { loading: false, show: true });
  } catch (err) {
    console.error("Search failed:", err);
    stopLoadingMessages();
    updateStatus(`Search failed: ${err.message}`, { loading: false, show: true });
  } finally {
    searchButton.disabled = false;
    productInput.disabled = false;
  }
}
