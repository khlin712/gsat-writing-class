(() => {
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (!gsap || prefersReducedMotion) return;

  if (ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
  }

  document.documentElement.classList.add("gsap-enhanced");

  const heroTitle = document.querySelector(".hero h1");
  const heroSubtitle = document.querySelector(".hero h1 span");
  const brand = document.querySelector(".brand");
  const navItems = document.querySelectorAll(".site-nav a");
  const heroOverlay = document.querySelector(".hero-overlay");
  const heroCopy = document.querySelector(".hero-copy");

  if (brand) gsap.set(brand, { opacity: 0, y: -10 });
  if (navItems.length) gsap.set(navItems, { opacity: 0, y: -8 });
  if (heroTitle) gsap.set(heroTitle, { opacity: 0, y: 34, scale: 0.97 });
  if (heroSubtitle) gsap.set(heroSubtitle, { opacity: 0, y: 20 });

  const introTimeline = gsap.timeline({
    defaults: { ease: "power3.out" },
  });

  if (brand) {
    introTimeline.to(brand, { opacity: 1, y: 0, duration: 0.65 });
  }

  if (navItems.length) {
    introTimeline.to(
      navItems,
      { opacity: 1, y: 0, duration: 0.45, stagger: 0.06 },
      "-=0.38"
    );
  }

  if (heroTitle) {
    introTimeline.to(
      heroTitle,
      { opacity: 1, y: 0, scale: 1, duration: 1.05 },
      "-=0.14"
    );
  }

  if (heroSubtitle) {
    introTimeline.to(
      heroSubtitle,
      { opacity: 1, y: 0, duration: 0.7 },
      "-=0.42"
    );
  }

  if (heroOverlay) {
    gsap.fromTo(
      heroOverlay,
      { opacity: 0.16 },
      {
        opacity: 0.38,
        duration: 2.2,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
      }
    );
  }

  if (ScrollTrigger && heroCopy && window.matchMedia("(min-width: 761px)").matches) {
    gsap.to(heroCopy, {
      yPercent: -10,
      opacity: 0.78,
      ease: "none",
      scrollTrigger: {
        trigger: ".hero",
        start: "top top",
        end: "bottom top",
        scrub: 1,
      },
    });
  }

  const reveal = (targets, trigger, options = {}) => {
    const nodes = gsap.utils.toArray(targets);
    if (!nodes.length) return;

    const fromVars = {
      opacity: 0,
      x: options.x || 0,
      y: options.y || 26,
      scale: options.scale || 1,
    };

    const toVars = {
      opacity: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: options.duration || 0.72,
      delay: options.delay || 0,
      stagger: options.stagger || 0,
      ease: "power3.out",
      clearProps: "opacity,transform",
    };

    if (ScrollTrigger) {
      toVars.scrollTrigger = {
        trigger,
        start: options.start || "top 82%",
        once: true,
      };
    }

    gsap.fromTo(nodes, fromVars, toVars);
  };

  reveal(".link-hub-main, .link-hub-social", ".link-hub", {
    y: 28,
    stagger: 0.12,
  });
  reveal(".hub-link", ".link-hub-main", {
    x: -18,
    y: 0,
    duration: 0.55,
    stagger: 0.08,
    start: "top 78%",
  });
  reveal(".hub-social", ".hub-social-grid", {
    y: 18,
    scale: 0.94,
    duration: 0.55,
    stagger: 0.08,
    start: "top 80%",
  });
  reveal(".hub-classroom", ".link-hub-social", {
    y: 18,
    scale: 0.97,
    duration: 0.6,
    delay: 0.18,
  });
  reveal(".hub-signup, .hub-registration", ".link-hub", {
    y: 24,
    scale: 0.98,
    duration: 0.68,
    stagger: 0.1,
    start: "top 76%",
  });
  reveal(".course-feature", ".courses-section", {
    y: 30,
    scale: 0.98,
    duration: 0.8,
    start: "top 80%",
  });

  const arrowItems = document.querySelectorAll(
    ".hub-link, .hub-classroom, .course-feature"
  );

  arrowItems.forEach((item) => {
    const arrow = item.querySelector(
      ".hub-link-arrow, .hub-classroom-arrow, .course-feature-link span"
    );
    if (!arrow) return;

    const moveArrow = () =>
      gsap.to(arrow, {
        x: 4,
        duration: 0.2,
        ease: "power2.out",
        overwrite: "auto",
      });
    const resetArrow = () =>
      gsap.to(arrow, {
        x: 0,
        duration: 0.24,
        ease: "power2.out",
        overwrite: "auto",
      });

    item.addEventListener("pointerenter", moveArrow);
    item.addEventListener("pointerleave", resetArrow);
    item.addEventListener("focusin", moveArrow);
    item.addEventListener("focusout", (event) => {
      if (!item.contains(event.relatedTarget)) resetArrow();
    });
  });
})();
