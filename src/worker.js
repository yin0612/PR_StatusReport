import worker from "./index.js";
import articleCache from "../.generated/article-cache.json";

// Generated outside public assets and Git. No route publishes article bodies.
export default {
  fetch(request, env, context) {
    return worker.fetch(request, { ...env, ARTICLE_CACHE: articleCache }, context);
  },
};
