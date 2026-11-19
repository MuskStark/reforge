import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  // 触屏设备（iPhone Duo 等）上 hover 态自动禁用，避免 iOS Safari 点击后光效粘滞
  future: { hoverOnlyWhenSupported: true },
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      boxShadow: {
        // Aceternity 官方 Input 使用的阴影 token
        input: "0px 1px 2px 0px rgb(0 0 0 / 0.05)",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "meteor-effect": "meteor 5s linear infinite",
        spotlight: "spotlight 2s ease .75s 1 forwards",
      },
      keyframes: {
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        meteor: {
          "0%": { transform: "rotate(215deg) translateX(0)", opacity: "1" },
          "70%": { opacity: "1" },
          "100%": { transform: "rotate(215deg) translateX(-500px)", opacity: "0" },
        },
        // Aceternity 官方 Spotlight 组件所需
        spotlight: {
          "0%": { opacity: "0", transform: "translate(-72%, -62%) scale(0.5)" },
          "100%": { opacity: "1", transform: "translate(-50%,-40%) scale(1)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
