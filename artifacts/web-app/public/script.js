document.getElementById("timestamp").textContent = new Date().toLocaleString();

let count = 0;
const countEl = document.getElementById("count");
const increment = document.getElementById("increment");
const decrement = document.getElementById("decrement");

increment.addEventListener("click", () => {
  count++;
  countEl.textContent = count;
});

decrement.addEventListener("click", () => {
  count--;
  countEl.textContent = count;
});
