import mongoose from "mongoose";

const priceSchema = new mongoose.Schema({
  store: String,
  title: String,
  price: Number,
  displayPrice: String,
  link: String
});

const productSchema = new mongoose.Schema({
  name: String,
  prices: [priceSchema],
  searchedAt: { type: Date, default: Date.now }
});

export default mongoose.model("Product", productSchema);
