const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");

if (navToggle && siteNav) {
  navToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  siteNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      siteNav.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

document.querySelectorAll("[data-tab-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.getAttribute("data-tab-target");
    if (!target) return;

    const wrapper = button.closest("main");
    if (!wrapper) return;

    wrapper.querySelectorAll(".tab-button").forEach((item) => {
      item.classList.toggle("is-active", item === button);
      item.setAttribute("aria-selected", String(item === button));
    });

    wrapper.querySelectorAll(".tab-panel").forEach((panel) => {
      const isMatch = panel.id === target;
      panel.classList.toggle("is-active", isMatch);
      panel.hidden = !isMatch;
    });
  });
});

document.querySelectorAll(".media-card img").forEach((image) => {
  image.addEventListener("load", () => {
    image.closest(".media-card")?.classList.add("is-ready");
  });
});
