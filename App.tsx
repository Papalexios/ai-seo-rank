import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import React, { useState, useMemo, useEffect, useCallback, useReducer, useRef, Component, ErrorInfo } from 'react';
import { generateFullSchema, generateSchemaMarkup } from './schema-generator';
import { PROMPT_TEMPLATES } from './prompts';
import { AI_MODELS } from './constants';
import { itemsReducer } from './state';
import { callAI, generateContent, generateImageWithFallback, publishItemToWordPress } from './services';
import { 
    AppFooter, AnalysisModal, BulkPublishModal, ReviewModal, SidebarNav, SkeletonLoader, ApiKeyInput, CheckIcon, XIcon, WordPressEndpointInstructions
} from './components';
import { 
    SitemapPage, ContentItem, GeneratedContent, SiteInfo, ExpandedGeoTargeting, ApiClients, WpConfig, NeuronConfig 
} from './types';
import { callAiWithRetry, debounce, fetchWordPressWithRetry, sanitizeTitle, extractSlugFromUrl, parseJsonWithAiRepair, isNullish, isValidSortKey } from './utils';
import { fetchWithProxies } from './contentUtils';
import { listNeuronProjects, NeuronProject } from './neuronwriter';

interface ErrorBoundaryProps {
    children?: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

// App.tsx - SOTA Error Boundary
export class SotaErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
      super(props);
      this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('SOTA_ERROR_BOUNDARY:', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="sota-error-fallback" style={{ padding: '2rem', textAlign: 'center', color: '#EAEBF2', backgroundColor: '#0A0A0F', height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: '#F87171' }}>System Critical Error</h1>
          <p style={{ color: '#A0A8C2', marginBottom: '2rem', maxWidth: '600px' }}>
             The application encountered an unexpected state. This is likely due to a temporary data inconsistency or network interruption.
          </p>
          <div style={{background: '#161622', padding: '1rem', borderRadius: '8px', textAlign: 'left', marginBottom: '2rem', overflow: 'auto', maxWidth: '800px'}}>
             <code style={{color: '#FCA5A5'}}>{this.state.error?.message || 'Unknown Error'}</code>
          </div>
          <button className="btn" onClick={() => {
              localStorage.removeItem('items'); // Clear potentially corrupted state
              window.location.reload();
          }}>
            Reset Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


const App = () => {
    const [activeView, setActiveView] = useState('setup');
    
    // Step 1: API Keys & Config
    const [apiKeys, setApiKeys] = useState(() => {
        const saved = localStorage.getItem('apiKeys');
        const defaults = { openaiApiKey: '', anthropicApiKey: '', openrouterApiKey: '', serperApiKey: '', groqApiKey: '' };
        let initialKeys;
        try {
            initialKeys = saved ? JSON.parse(saved) : defaults;
        } catch (e) {
            console.warn("Corrupted 'apiKeys' in localStorage. Resetting to defaults.", e);
            initialKeys = defaults;
        }
        if (initialKeys.geminiApiKey) {
            delete initialKeys.geminiApiKey;
        }
        return initialKeys;
    });
    const [apiKeyStatus, setApiKeyStatus] = useState({ gemini: 'idle', openai: 'idle', anthropic: 'idle', openrouter: 'idle', serper: 'idle', groq: 'idle' } as Record<string, 'idle' | 'validating' | 'valid' | 'invalid'>);
    const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
    const [apiClients, setApiClients] = useState<ApiClients>({ gemini: null, openai: null, anthropic: null, openrouter: null, groq: null });
    const [selectedModel, setSelectedModel] = useState(() => {
        const saved = localStorage.getItem('selectedModel');
        return saved && ['gemini', 'openai', 'anthropic', 'openrouter', 'groq'].includes(saved) ? saved : 'gemini';
    });
    const [selectedGroqModel, setSelectedGroqModel] = useState(() => localStorage.getItem('selectedGroqModel') || AI_MODELS.GROQ_MODELS[0]);
    const [openrouterModels, setOpenrouterModels] = useState<string[]>(AI_MODELS.OPENROUTER_DEFAULT);
    const [geoTargeting, setGeoTargeting] = useState<ExpandedGeoTargeting>(() => {
        const saved = localStorage.getItem('geoTargeting');
        const defaults = { enabled: false, location: '', region: '', country: '', postalCode: '' };
        try {
            return saved ? JSON.parse(saved) : defaults;
        } catch (e) {
            console.warn("Corrupted 'geoTargeting' in localStorage. Resetting to defaults.", e);
            return defaults;
        }
    });
    const [useGoogleSearch, setUseGoogleSearch] = useState(false);

    // NeuronWriter Config & State
    const [neuronConfig, setNeuronConfig] = useState<NeuronConfig>(() => {
        const saved = localStorage.getItem('neuronConfig');
        const defaults = { apiKey: '', projectId: '', enabled: false };
        try {
            return saved ? JSON.parse(saved) : defaults;
        } catch (e) {
            return defaults;
        }
    });
    const [neuronProjects, setNeuronProjects] = useState<NeuronProject[]>([]);
    const [isFetchingNeuronProjects, setIsFetchingNeuronProjects] = useState(false);
    const [neuronFetchError, setNeuronFetchError] = useState('');


    // Step 2: Content Strategy
    const [contentMode, setContentMode] = useState('bulk'); // 'bulk', 'single', or 'imageGenerator'
    const [topic, setTopic] = useState('');
    const [primaryKeywords, setPrimaryKeywords] = useState('');
    const [sitemapUrl, setSitemapUrl] = useState('');
    const [isCrawling, setIsCrawling] = useState(false);
    const [crawlMessage, setCrawlMessage] = useState('');
    const [crawlProgress, setCrawlProgress] = useState({ current: 0, total: 0 });
    const [existingPages, setExistingPages] = useState<SitemapPage[]>([]);
    const [wpConfig, setWpConfig] = useState<WpConfig>(() => {
        const saved = localStorage.getItem('wpConfig');
        const defaults = { url: '', username: '' };
        try {
            return saved ? JSON.parse(saved) : defaults;
        } catch (e) {
            console.warn("Corrupted 'wpConfig' in localStorage. Resetting to defaults.", e);
            return defaults;
        }
    });
    const [wpPassword, setWpPassword] = useState(() => localStorage.getItem('wpPassword') || '');
    const [wpEndpointStatus, setWpEndpointStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [isEndpointModalOpen, setIsEndpointModalOpen] = useState(false);
    const [siteInfo, setSiteInfo] = useState<SiteInfo>(() => {
        const saved = localStorage.getItem('siteInfo');
        const defaults = {
            orgName: '', orgUrl: '', logoUrl: '', orgSameAs: [],
            authorName: '', authorUrl: '', authorSameAs: []
        };
        try {
            return saved ? JSON.parse(saved) : defaults;
        } catch (e) {
            console.warn("Corrupted 'siteInfo' in localStorage. Resetting to defaults.", e);
            return defaults;
        }
    });


    // Image Generator State
    const [imagePrompt, setImagePrompt] = useState('');
    const [numImages, setNumImages] = useState(1);
    const [aspectRatio, setAspectRatio] = useState('1:1');
    const [isGeneratingImages, setIsGeneratingImages] = useState(false);
    const [generatedImages, setGeneratedImages] = useState<{ src: string, prompt: string }[]>([]); // Array of { src: string, prompt: string }
    const [imageGenerationError, setImageGenerationError] = useState('');

    // Step 3: Generation & Review
    const [items, dispatch] = useReducer(itemsReducer, []);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0 });
    const [selectedItems, setSelectedItems] = useState(new Set<string>());
    const [filter, setFilter] = useState('');
    const [sortConfig, setSortConfig] = useState({ key: 'title', direction: 'asc' });
    const [selectedItemForReview, setSelectedItemForReview] = useState<ContentItem | null>(null);
    const [isBulkPublishModalOpen, setIsBulkPublishModalOpen] = useState(false);
    const stopGenerationRef = useRef(new Set<string>());
    
    // Content Hub State
    const [hubSearchFilter, setHubSearchFilter] = useState('');
    const [hubStatusFilter, setHubStatusFilter] = useState('All');
    const [hubSortConfig, setHubSortConfig] = useState<{key: string, direction: 'asc' | 'desc'}>({ key: 'default', direction: 'desc' });
    const [isAnalyzingHealth, setIsAnalyzingHealth] = useState(false);
    const [healthAnalysisProgress, setHealthAnalysisProgress] = useState({ current: 0, total: 0 });
    const [selectedHubPages, setSelectedHubPages] = useState(new Set<string>());
    const [viewingAnalysis, setViewingAnalysis] = useState<SitemapPage | null>(null);
    
    // --- Effects ---
    
    useEffect(() => { localStorage.setItem('apiKeys', JSON.stringify(apiKeys)); }, [apiKeys]);
    useEffect(() => { localStorage.setItem('selectedModel', selectedModel); }, [selectedModel]);
    useEffect(() => { localStorage.setItem('selectedGroqModel', selectedGroqModel); }, [selectedGroqModel]);
    useEffect(() => { localStorage.setItem('wpConfig', JSON.stringify(wpConfig)); }, [wpConfig]);
    useEffect(() => { localStorage.setItem('wpPassword', wpPassword); }, [wpPassword]);
    useEffect(() => { localStorage.setItem('geoTargeting', JSON.stringify(geoTargeting)); }, [geoTargeting]);
    useEffect(() => { localStorage.setItem('siteInfo', JSON.stringify(siteInfo)); }, [siteInfo]);
    useEffect(() => { localStorage.setItem('neuronConfig', JSON.stringify(neuronConfig)); }, [neuronConfig]);

    // Handle Auto-Load Projects for NeuronWriter
    // Use a ref to prevent duplicate fetching in strict mode or rapid updates
    const fetchProjectsRef = useRef<string>('');

    const fetchProjects = useCallback(async (key: string) => {
        if (!key || key.trim().length < 10) {
            setNeuronProjects([]);
            setNeuronFetchError('');
            return;
        }
        
        // Prevent fetching if the key hasn't changed and we have data/error
        if (fetchProjectsRef.current === key && (neuronProjects.length > 0 || neuronFetchError)) {
            return;
        }

        setIsFetchingNeuronProjects(true);
        setNeuronFetchError('');
        fetchProjectsRef.current = key;

        try {
            const projects = await listNeuronProjects(key);
            setNeuronProjects(projects);
            // Auto-select first project if none selected
            if (projects.length > 0 && !neuronConfig.projectId) {
                 setNeuronConfig(prev => ({ ...prev, projectId: projects[0].project }));
            }
        } catch (err: any) {
            console.error("Failed to auto-fetch NeuronWriter projects:", err);
            setNeuronFetchError(err.message || 'Failed to fetch projects');
            setNeuronProjects([]);
        } finally {
            setIsFetchingNeuronProjects(false);
        }
    }, [neuronConfig.projectId, neuronProjects.length, neuronFetchError]);

    // Debounce the fetch trigger
    useEffect(() => {
        if (neuronConfig.enabled && neuronConfig.apiKey) {
            const timer = setTimeout(() => {
                fetchProjects(neuronConfig.apiKey);
            }, 800); // 800ms debounce
            return () => clearTimeout(timer);
        }
    }, [neuronConfig.enabled, neuronConfig.apiKey, fetchProjects]);


    // App.tsx - SOTA APP BOOTSTRAP
    const bootstrapApp = () => {
        // 1. Validate localStorage integrity
        const criticalKeys = ['apiKeys', 'wpConfig', 'siteInfo'];
        criticalKeys.forEach(key => {
            try {
                const data = localStorage.getItem(key);
                if (data) JSON.parse(data);
            } catch {
                console.warn(`Corrupted ${key} in localStorage, resetting...`);
                localStorage.removeItem(key);
            }
        });

        // 2. Validate environment
        if (!process.env.API_KEY) {
            console.error('CRITICAL: GEMINI_API_KEY not found in environment');
        }
    };

    useEffect(() => {
        bootstrapApp();
    }, []);

    useEffect(() => {
        (async () => {
            if (process.env.API_KEY) {
                try {
                    setApiKeyStatus(prev => ({...prev, gemini: 'validating' }));
                    const geminiClient = new GoogleGenAI({ apiKey: process.env.API_KEY });
                    await callAiWithRetry(() => geminiClient.models.generateContent({ model: AI_MODELS.GEMINI_FLASH, contents: 'test' }));
                    setApiClients(prev => ({ ...prev, gemini: geminiClient }));
                    setApiKeyStatus(prev => ({...prev, gemini: 'valid' }));
                } catch (e) {
                    console.error("Gemini client initialization/validation failed:", e);
                    setApiClients(prev => ({ ...prev, gemini: null }));
                    setApiKeyStatus(prev => ({...prev, gemini: 'invalid' }));
                }
            } else {
                console.error("Gemini API key (API_KEY environment variable) is not set.");
                setApiClients(prev => ({ ...prev, gemini: null }));
                setApiKeyStatus(prev => ({...prev, gemini: 'invalid' }));
            }
        })();
    }, []);

    useEffect(() => {
        setSelectedHubPages(new Set());
    }, [hubSearchFilter, hubStatusFilter]);

     const filteredAndSortedHubPages = useMemo(() => {
        let filtered = [...existingPages];

        if (hubStatusFilter !== 'All') {
            filtered = filtered.filter(page => page.updatePriority === hubStatusFilter);
        }

        if (hubSearchFilter) {
            filtered = filtered.filter(page =>
                page.title.toLowerCase().includes(hubSearchFilter.toLowerCase()) ||
                page.id.toLowerCase().includes(hubSearchFilter.toLowerCase())
            );
        }

        if (hubSortConfig.key === 'default') {
             filtered.sort((a, b) => {
                if (!a || !b) return 0;
                if (a.isStale !== b.isStale) {
                    return a.isStale ? -1 : 1;
                }
                if (a.daysOld !== b.daysOld) {
                    return (b.daysOld ?? 0) - (a.daysOld ?? 0);
                }
                return (a.wordCount ?? 0) - (b.wordCount ?? 0);
             });
        } else if (hubSortConfig.key && isValidSortKey(hubSortConfig.key, filtered[0])) {
            filtered.sort((a, b) => {
                if (!a || !b) {
                    console.warn('Skipping sort for undefined entries:', { a, b });
                    return 0;
                }

                const getValue = (obj: any, key: string) => {
                    const value = obj?.[key as keyof typeof obj];
                    if (isNullish(value)) {
                        return hubSortConfig.direction === 'asc' ? Infinity : -Infinity;
                    }
                    return value;
                };

                let valA = getValue(a, hubSortConfig.key);
                let valB = getValue(b, hubSortConfig.key);

                if (typeof valA === 'boolean' && typeof valB === 'boolean') {
                    return (valA === valB ? 0 : (valA ? -1 : 1)) * (hubSortConfig.direction === 'asc' ? 1 : -1);
                }

                if (valA < valB) {
                    return hubSortConfig.direction === 'asc' ? -1 : 1;
                }
                if (valA > valB) {
                    return hubSortConfig.direction === 'asc' ? 1 : -1;
                }
                return 0;
            });
        }
        return filtered;
    }, [existingPages, hubSearchFilter, hubStatusFilter, hubSortConfig]);

    const validateApiKey = useCallback(debounce(async (provider: string, key: string) => {
        if (!key) {
            setApiKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
            setApiClients(prev => ({ ...prev, [provider]: null }));
            return;
        }

        setApiKeyStatus(prev => ({ ...prev, [provider]: 'validating' }));

        try {
            let client;
            let isValid = false;
            switch (provider) {
                case 'openai':
                    client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
                    await callAiWithRetry(() => client.models.list());
                    isValid = true;
                    break;
                case 'anthropic':
                    client = new Anthropic({ apiKey: key });
                    await callAiWithRetry(() => client.messages.create({
                        model: AI_MODELS.ANTHROPIC_HAIKU,
                        max_tokens: 1,
                        messages: [{ role: "user", content: "test" }],
                    }));
                    isValid = true;
                    break;
                 case 'openrouter':
                    client = new OpenAI({
                        baseURL: "https://openrouter.ai/api/v1",
                        apiKey: key,
                        dangerouslyAllowBrowser: true,
                        defaultHeaders: {
                            'HTTP-Referer': window.location.href,
                            'X-Title': 'WP Content Optimizer Pro',
                        }
                    });
                    await callAiWithRetry(() => client.chat.completions.create({
                        model: 'google/gemini-2.5-flash',
                        messages: [{ role: "user", content: "test" }],
                        max_tokens: 1
                    }));
                    isValid = true;
                    break;
                case 'groq':
                    client = new OpenAI({
                        baseURL: "https://api.groq.com/openai/v1",
                        apiKey: key,
                        dangerouslyAllowBrowser: true,
                    });
                    await callAiWithRetry(() => client.chat.completions.create({
                        model: selectedGroqModel,
                        messages: [{ role: "user", content: "test" }],
                        max_tokens: 1
                    }));
                    isValid = true;
                    break;
                 case 'serper':
                    const serperResponse = await fetchWithProxies("https://google.serper.dev/search", {
                        method: 'POST',
                        headers: {
                            'X-API-KEY': key,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ q: 'test' })
                    });
                    if (serperResponse.ok) {
                        isValid = true;
                    } else {
                        const errorBody = await serperResponse.json().catch(() => ({ message: `Serper validation failed with status ${serperResponse.status}` }));
                        throw new Error(errorBody.message || `Serper validation failed with status ${serperResponse.status}`);
                    }
                    break;
            }

            if (isValid) {
                setApiKeyStatus(prev => ({ ...prev, [provider]: 'valid' }));
                if (client) {
                     setApiClients(prev => ({ ...prev, [provider]: client as any }));
                }
                setEditingApiKey(null);
            } else {
                 throw new Error("Validation check failed.");
            }
        } catch (error: any) {
            console.error(`${provider} API key validation failed:`, error);
            setApiKeyStatus(prev => ({ ...prev, [provider]: 'invalid' }));
            setApiClients(prev => ({ ...prev, [provider]: null }));
        }
    }, 500), [selectedGroqModel]);
    
     useEffect(() => {
        Object.entries(apiKeys).forEach(([key, value]) => {
            if (value) {
                validateApiKey(key.replace('ApiKey', ''), value as string);
            }
        });
    }, []);

    // Re-validate Groq key when the model changes to give user feedback
    useEffect(() => {
        if (selectedModel === 'groq' && apiKeys.groqApiKey) {
            validateApiKey('groq', apiKeys.groqApiKey);
        }
    }, [selectedModel, selectedGroqModel, apiKeys.groqApiKey, validateApiKey]);

    const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        const provider = name.replace('ApiKey', '');
        setApiKeys(prev => ({ ...prev, [name]: value }));
        validateApiKey(provider, value);
    };
    
    const handleOpenrouterModelsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setOpenrouterModels(e.target.value.split('\n').map(m => m.trim()).filter(Boolean));
    };

    const handleHubSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (hubSortConfig.key === key && hubSortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setHubSortConfig({ key, direction });
    };

    const stopHealthAnalysisRef = useRef(false);

    const handleAnalyzeSelectedPages = async () => {
        const pagesToAnalyze = existingPages.filter(p => selectedHubPages.has(p.id));
        if (pagesToAnalyze.length === 0) {
            alert("No pages selected to analyze.");
            return;
        }

        const client = apiClients[selectedModel as keyof typeof apiClients];
        if (!client) {
            alert("API client not available. Please check your API key in Step 1.");
            return;
        }
        
        stopHealthAnalysisRef.current = false;
        setIsAnalyzingHealth(true);
        setHealthAnalysisProgress({ current: 0, total: pagesToAnalyze.length });

        const serviceCallAI = (promptKey: any, args: any[], format: 'json' | 'html' = 'json', grounding = false) => callAI(
            apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, promptKey, args, format, grounding
        );

        await generateContent.analyzePages(pagesToAnalyze, serviceCallAI, setExistingPages, (progress) => setHealthAnalysisProgress(progress), () => stopHealthAnalysisRef.current);

        setIsAnalyzingHealth(false);
    };


    const handlePlanRewrite = (page: SitemapPage) => {
        const newItem: ContentItem = { 
            id: page.id,
            title: sanitizeTitle(page.title, page.slug), 
            type: 'standard', 
            originalUrl: page.id, 
            status: 'idle', 
            statusText: 'Ready to Rewrite', 
            generatedContent: null, 
            crawledContent: page.crawledContent,
            analysis: page.analysis,
        };
        dispatch({ type: 'SET_ITEMS', payload: [newItem] });
        setActiveView('review');
    };
    
    const handleToggleHubPageSelect = (pageId: string) => {
        setSelectedHubPages(prev => {
            const newSet = new Set(prev);
            if (newSet.has(pageId)) {
                newSet.delete(pageId);
            } else {
                newSet.add(pageId);
            }
            return newSet;
        });
    };

    const handleToggleHubPageSelectAll = () => {
        if (selectedHubPages.size === filteredAndSortedHubPages.length) {
            setSelectedHubPages(new Set());
        } else {
            setSelectedHubPages(new Set(filteredAndSortedHubPages.map(p => p.id)));
        }
    };
    
     const analyzableForRewrite = useMemo(() => {
        return existingPages.filter(p => selectedHubPages.has(p.id) && p.analysis).length;
    }, [selectedHubPages, existingPages]);

    const handleRewriteSelected = () => {
        const selectedPages = existingPages.filter(p => selectedHubPages.has(p.id) && p.analysis);
        if (selectedPages.length === 0) {
            alert("Please select one or more pages that have been successfully analyzed to plan a rewrite. Run the analysis first if you haven't.");
            return;
        }

        const newItems: ContentItem[] = selectedPages.map(page => ({
            id: page.id,
            title: sanitizeTitle(page.title, page.slug),
            type: 'standard',
            originalUrl: page.id,
            status: 'idle',
            statusText: 'Ready to Rewrite',
            generatedContent: null,
            crawledContent: page.crawledContent,
            analysis: page.analysis,
        }));
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setSelectedHubPages(new Set());
        setActiveView('review');
    };
    
    const handleCrawlSitemap = async () => {
        if (!sitemapUrl) {
            setCrawlMessage('Please enter a sitemap URL.');
            return;
        }

        setIsCrawling(true);
        setCrawlMessage('');
        setExistingPages([]);
        
        const onCrawlProgress = (message: string) => setCrawlMessage(message);
        
        try {
            const MAX_SITEMAPS_TO_CRAWL = 100;
            const MAX_PAGES_TO_DISCOVER = 50000;

            const sitemapsToCrawl = [sitemapUrl];
            const crawledSitemapUrls = new Set<string>();
            const pageDataMap = new Map<string, { lastmod: string | null }>();

            const sanitizeUrl = (url: string) => url.trim();

            while (sitemapsToCrawl.length > 0) {
                if (crawledSitemapUrls.size >= MAX_SITEMAPS_TO_CRAWL) {
                    onCrawlProgress(`Warning: Reached crawl limit of ${MAX_SITEMAPS_TO_CRAWL} sitemaps. The page list may be incomplete.`);
                    break;
                }
                 if (pageDataMap.size >= MAX_PAGES_TO_DISCOVER) {
                    onCrawlProgress(`Warning: Reached discovery limit of ${MAX_PAGES_TO_DISCOVER} pages. The page list may be incomplete.`);
                    break;
                }

                const currentSitemapUrl = sitemapsToCrawl.shift();
                if (!currentSitemapUrl || crawledSitemapUrls.has(currentSitemapUrl)) continue;

                crawledSitemapUrls.add(currentSitemapUrl);
                onCrawlProgress(`Crawling (${crawledSitemapUrls.size}/${sitemapsToCrawl.length + crawledSitemapUrls.size}): ${currentSitemapUrl.substring(0, 100)}... (Found ${pageDataMap.size} pages)`);

                const response = await fetchWithProxies(currentSitemapUrl, {}, onCrawlProgress);
                const text = await response.text();
                
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "application/xml");
                const parserError = doc.getElementsByTagName("parsererror");
                let foundSomething = false;

                if (parserError.length === 0) {
                    onCrawlProgress(`Parsing as XML...`);
                    const sitemapNodes = doc.getElementsByTagName('sitemap');
                    for (let i = 0; i < sitemapNodes.length; i++) {
                        const loc = sitemapNodes[i].getElementsByTagName('loc')[0]?.textContent;
                        if (loc) {
                            const url = sanitizeUrl(loc);
                            if (!crawledSitemapUrls.has(url) && sitemapsToCrawl.length < MAX_SITEMAPS_TO_CRAWL) {
                                sitemapsToCrawl.push(url);
                                foundSomething = true;
                            }
                        }
                    }

                    const urlNodes = doc.getElementsByTagName('url');
                    for (let i = 0; i < urlNodes.length; i++) {
                        const loc = urlNodes[i].getElementsByTagName('loc')[0]?.textContent;
                        if (loc) {
                            const url = sanitizeUrl(loc);
                            if (!pageDataMap.has(url) && pageDataMap.size < MAX_PAGES_TO_DISCOVER) {
                                const lastmod = urlNodes[i].getElementsByTagName('lastmod')[0]?.textContent;
                                pageDataMap.set(url, { lastmod: lastmod ? lastmod.trim() : null });
                                foundSomething = true;
                            }
                        }
                    }
                }

                if (parserError.length > 0 || !foundSomething) {
                    if (parserError.length > 0) {
                        onCrawlProgress(`Warning: XML parsing failed for ${currentSitemapUrl}. Falling back to plain text scan.`);
                    } else {
                        onCrawlProgress(`Note: No sitemap/url entries found in XML. Scanning for plain text URLs as a fallback.`);
                    }

                    const lines = text.split(/[\r\n]+/);
                    let plainTextUrls = 0;
                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        const urlMatch = trimmedLine.match(/https?:\/\/[^\s<]+/);
                        if (urlMatch) {
                            const potentialUrl = urlMatch[0];
                            try {
                                new URL(potentialUrl);
                                if (potentialUrl.endsWith('.xml') || potentialUrl.endsWith('.xml.gz')) {
                                    if (!crawledSitemapUrls.has(potentialUrl) && sitemapsToCrawl.length < MAX_SITEMAPS_TO_CRAWL) {
                                        sitemapsToCrawl.push(potentialUrl);
                                        plainTextUrls++;
                                    }
                                } else {
                                    if (!pageDataMap.has(potentialUrl) && pageDataMap.size < MAX_PAGES_TO_DISCOVER) {
                                        pageDataMap.set(potentialUrl, { lastmod: null });
                                        plainTextUrls++;
                                    }
                                }
                            } catch (_) { /* Not a valid URL, ignore */ }
                        }
                    }
                    if (plainTextUrls > 0) {
                        onCrawlProgress(`Note: Found ${plainTextUrls} URLs via plain-text parser for ${currentSitemapUrl}.`);
                        foundSomething = true;
                    }
                }

                 if (!foundSomething) {
                    onCrawlProgress(`Warning: No valid URLs or sitemaps found in ${currentSitemapUrl}. It may be empty or malformed.`);
                }
            }

            const discoveredPages: SitemapPage[] = Array.from(pageDataMap.entries()).map(([url, data]) => {
                const currentDate = new Date();
                let daysOld = null;
                let isStale = false;
                if (data.lastmod) {
                    const lastModDate = new Date(data.lastmod);
                    if (!isNaN(lastModDate.getTime())) {
                        daysOld = Math.round((currentDate.getTime() - lastModDate.getTime()) / (1000 * 3600 * 24));
                        if (daysOld > 365) isStale = true;
                    }
                }
                return {
                    id: url,
                    title: url,
                    slug: extractSlugFromUrl(url),
                    lastMod: data.lastmod,
                    wordCount: null,
                    crawledContent: null,
                    healthScore: null,
                    updatePriority: null,
                    justification: null,
                    daysOld: daysOld,
                    isStale: isStale,
                    publishedState: 'none',
                    status: 'idle',
                    analysis: null,
                };
            });
            
            if (discoveredPages.length === 0) {
                 onCrawlProgress('Crawl complete, but no page URLs were found.');
            } else {
                setExistingPages(discoveredPages);
                onCrawlProgress(`Discovery successful! Found ${discoveredPages.length} pages. Select pages and click 'Analyze' to process content.`);
            }
        } catch (error: any) {
            onCrawlProgress(`An error occurred during crawl: ${error.message}`);
        } finally {
            setIsCrawling(false);
        }
    };

    const verifyWpEndpoint = useCallback(async () => {
        if (!wpConfig.url) {
            alert("Please enter your WordPress Site URL first.");
            return;
        }
        setWpEndpointStatus('verifying');
        try {
            const endpointUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/`;
            const response = await fetch(endpointUrl, { method: 'GET' });
            
            if (response.ok) {
                const data = await response.json();
                if (data.name && data.url) {
                    setWpEndpointStatus('valid');
                    return;
                }
            }
            setWpEndpointStatus('invalid');
        } catch (error) {
            console.error("Endpoint verification failed:", error);
            setWpEndpointStatus('invalid');
        }
    }, [wpConfig.url]);
    
    const handleGenerateClusterPlan = async () => {
        setIsGenerating(true);
        dispatch({ type: 'SET_ITEMS', payload: [] });
    
        try {
            const responseText = await callAI(apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, 'cluster_planner', [topic, null, null], 'json');
            
            const aiRepairer = (brokenText: string) => callAI(
                apiClients, 'gemini', { enabled: false, location: '', region: '', country: '', postalCode: '' }, [], '', 'json_repair', [brokenText], 'json'
            );

            const parsedJson = await parseJsonWithAiRepair(responseText, aiRepairer);
            
            const newItems: Partial<ContentItem>[] = [
                { id: parsedJson.pillarTitle, title: parsedJson.pillarTitle, type: 'pillar' },
                ...parsedJson.clusterTitles.map((cluster: { title: string }) => ({ id: cluster.title, title: cluster.title, type: 'cluster' }))
            ];
            dispatch({ type: 'SET_ITEMS', payload: newItems });
            setActiveView('review');
    
        } catch (error: any) {
            console.error("Error generating cluster plan:", error);
            const errorItem: ContentItem = {
                id: 'error-item', title: 'Failed to Generate Plan', type: 'standard', status: 'error',
                statusText: `An error occurred: ${error.message}`, generatedContent: null, crawledContent: null
            };
            dispatch({ type: 'SET_ITEMS', payload: [errorItem] });
        } finally {
            setIsGenerating(false);
        }
    };
    
    const handleGenerateMultipleFromKeywords = () => {
        const keywords = primaryKeywords.split('\n').map(k => k.trim()).filter(Boolean);
        if (keywords.length === 0) return;

        const newItems: Partial<ContentItem>[] = keywords.map(keyword => ({
            id: keyword,
            title: keyword,
            type: 'standard'
        }));
        
        dispatch({ type: 'SET_ITEMS', payload: newItems });
        setActiveView('review');
    };

    const handleGenerateImages = async () => {
        if (!apiClients.gemini && !apiClients.openai) {
            setImageGenerationError('Please enter a valid Gemini or OpenAI API key in Step 1 to generate images.');
            return;
        }
        if (!imagePrompt) {
            setImageGenerationError('Please enter a prompt to generate an image.');
            return;
        }

        setIsGeneratingImages(true);
        setGeneratedImages([]);
        setImageGenerationError('');

        try {
            const imageService = async (prompt: string) => {
                const src = await generateImageWithFallback(apiClients, prompt);
                if (!src) throw new Error("All image generation services failed.");
                return src;
            };

            const imagePromises = Array.from({ length: numImages }).map(() => imageService(imagePrompt));
            const results = await Promise.all(imagePromises);
            
            const imagesData = results.map(src => ({ src, prompt: imagePrompt }));
            setGeneratedImages(imagesData);

        } catch (error: any) {
            console.error("Image generation failed:", error);
            setImageGenerationError(`An error occurred: ${error.message}`);
        } finally {
            setIsGeneratingImages(false);
        }
    };

    const handleDownloadImage = (base64Data: string, prompt: string) => {
        const link = document.createElement('a');
        link.href = base64Data;
        const safePrompt = prompt.substring(0, 30).replace(/[^a-z0-9]/gi, '_').toLowerCase();
        link.download = `generated-image-${safePrompt}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleCopyText = (text: string) => {
        navigator.clipboard.writeText(text).catch(err => {
            console.error('Failed to copy text: ', err);
        });
    };

    const handleToggleSelect = (itemId: string) => {
        setSelectedItems(prev => {
            const newSet = new Set(prev);
            if (newSet.has(itemId)) {
                newSet.delete(itemId);
            } else {
                newSet.add(itemId);
            }
            return newSet;
        });
    };

    const handleToggleSelectAll = () => {
        if (selectedItems.size === filteredAndSortedItems.length) {
            setSelectedItems(new Set());
        } else {
            setSelectedItems(new Set(filteredAndSortedItems.map(item => item.id)));
        }
    };
    
     const filteredAndSortedItems = useMemo(() => {
        // Guard 1: Filter out any null/undefined items from the source array.
        let sorted = items.filter(Boolean);

        // Guard 2: Only sort if sortConfig and its key are valid strings.
        if (sortConfig && typeof sortConfig.key === 'string') {
            sorted.sort((a, b) => {
                // Guard 3: In-place check for items, though filter(Boolean) should prevent this.
                if (!a || !b) return 0;

                const valA = a[sortConfig.key as keyof typeof a];
                const valB = b[sortConfig.key as keyof typeof b];

                // Handle nullish values to prevent crashes and ensure consistent sorting.
                if (valA === null || valA === undefined) return 1;  // Put nulls/undefineds at the end
                if (valB === null || valB === undefined) return -1;

                if (valA < valB) {
                    return sortConfig.direction === 'asc' ? -1 : 1;
                }
                if (valA > valB) {
                    return sortConfig.direction === 'asc' ? 1 : -1;
                }
                return 0;
            });
        }
        
        if (filter) {
            return sorted.filter(item => item && item.title && item.title.toLowerCase().includes(filter.toLowerCase()));
        }
        
        return sorted;
    }, [items, filter, sortConfig]);

    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const startGeneration = async (itemsToGenerate: ContentItem[]) => {
        setIsGenerating(true);
        setGenerationProgress({ current: 0, total: itemsToGenerate.length });
        
        const serviceCallAI = (promptKey: any, args: any[], format: 'json' | 'html' = 'json', grounding = false) => callAI(
            apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, promptKey, args, format, grounding
        );
        
        const serviceGenerateImage = (prompt: string) => generateImageWithFallback(apiClients, prompt);

        await generateContent.generateItems(
            itemsToGenerate,
            serviceCallAI,
            serviceGenerateImage,
            {
                dispatch,
                existingPages,
                siteInfo,
                wpConfig,
                geoTargeting,
                serperApiKey: apiKeys.serperApiKey,
                apiKeyStatus,
                // SOTA FIX: Add missing required properties to prevent undefined access
                apiClients,
                selectedModel,
                openrouterModels,
                selectedGroqModel,
                neuronConfig
            },
            (progress) => setGenerationProgress(progress),
            () => stopGenerationRef
        );

        setIsGenerating(false);
    };

    const handleGenerateSingle = (item: ContentItem) => {
        stopGenerationRef.current.delete(item.id);
        startGeneration([item]);
    };

    const handleGenerateSelected = () => {
        stopGenerationRef.current.clear();
        const itemsToGenerate = items.filter(item => selectedItems.has(item.id));
        if (itemsToGenerate.length > 0) {
            startGeneration(itemsToGenerate);
        }
    };
    
     const handleStopGeneration = (itemId: string | null = null) => {
        if (itemId) {
            stopGenerationRef.current.add(itemId);
             dispatch({
                type: 'UPDATE_STATUS',
                payload: { id: itemId, status: 'idle', statusText: 'Stopped by user' }
            });
        } else {
            // Stop all
            items.forEach(item => {
                if (item.status === 'generating') {
                    stopGenerationRef.current.add(item.id);
                     dispatch({
                        type: 'UPDATE_STATUS',
                        payload: { id: item.id, status: 'idle', statusText: 'Stopped by user' }
                    });
                }
            });
            setIsGenerating(false);
        }
    };
    

    return (
        <div className="app-container">
            <header className="app-header">
                <div className="app-header-content">
                    <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">
                        <img src="https://affiliatemarketingforsuccess.com/wp-content/uploads/2023/03/cropped-Affiliate-Marketing-for-Success-Logo-Edited.png?lm=6666FEE0" alt="WP Content Optimizer Pro Logo" className="header-logo" />
                    </a>
                    <div className="header-title-group">
                        <h1>WP Content <span>Optimizer Pro</span></h1>
                        <p className="header-tagline">By <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">Alexios Papaioannou</a></p>
                    </div>
                </div>
            </header>
            <div className="main-layout">
                <aside className="sidebar">
                    <SidebarNav activeView={activeView} onNavClick={setActiveView} />
                </aside>
                <main className="main-content">
                    {activeView === 'setup' && (
                        <div className="setup-view">
                            <div className="page-header">
                                <h2 className="gradient-headline">1. Setup & Configuration</h2>
                                <p>Connect your AI services and WordPress site to get started. All keys are stored securely in your browser's local storage.</p>
                            </div>
                            <div className="setup-grid">
                                <div className="setup-card">
                                    <h3>API Keys</h3>
                                    <div className="form-group">
                                        <label>Google Gemini API Key</label>
                                        <div className="api-key-group">
                                            <input type="text" readOnly value="Loaded from Environment" disabled />
                                             <div className="key-status-icon">
                                                {apiKeyStatus.gemini === 'validating' && <div className="key-status-spinner"></div>}
                                                {apiKeyStatus.gemini === 'valid' && <span className="success"><CheckIcon /></span>}
                                                {apiKeyStatus.gemini === 'invalid' && <span className="error"><XIcon /></span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="form-group">
                                        <label>OpenAI API Key</label>
                                        <ApiKeyInput provider="openai" value={apiKeys.openaiApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.openai} isEditing={editingApiKey === 'openai'} onEdit={() => setEditingApiKey('openai')} />
                                    </div>
                                    <div className="form-group">
                                        <label>Anthropic API Key</label>
                                        <ApiKeyInput provider="anthropic" value={apiKeys.anthropicApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.anthropic} isEditing={editingApiKey === 'anthropic'} onEdit={() => setEditingApiKey('anthropic')} />
                                    </div>
                                     <div className="form-group">
                                        <label>OpenRouter API Key</label>
                                        <ApiKeyInput provider="openrouter" value={apiKeys.openrouterApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.openrouter} isEditing={editingApiKey === 'openrouter'} onEdit={() => setEditingApiKey('openrouter')} />
                                    </div>
                                     <div className="form-group">
                                        <label>Groq API Key</label>
                                        <ApiKeyInput provider="groq" value={apiKeys.groqApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.groq} isEditing={editingApiKey === 'groq'} onEdit={() => setEditingApiKey('groq')} />
                                    </div>
                                    <div className="form-group">
                                        <label>Serper API Key</label>
                                        <ApiKeyInput provider="serper" value={apiKeys.serperApiKey} onChange={handleApiKeyChange} status={apiKeyStatus.serper} isEditing={editingApiKey === 'serper'} onEdit={() => setEditingApiKey('serper')} />
                                    </div>
                                </div>
                                <div className="setup-card">
                                    <h3>AI Model Configuration</h3>
                                    <div className="form-group">
                                        <label htmlFor="model-select">Primary Generation Model</label>
                                        <select id="model-select" value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                                            <option value="gemini">Google Gemini 2.5 Flash</option>
                                            <option value="openai">OpenAI GPT-4o</option>
                                            <option value="anthropic">Anthropic Claude 3</option>
                                            <option value="openrouter">OpenRouter (Auto-Fallback)</option>
                                            <option value="groq">Groq (High-Speed)</option>
                                        </select>
                                    </div>
                                    {selectedModel === 'openrouter' && (
                                        <div className="form-group">
                                            <label>OpenRouter Model Fallback Chain (one per line)</label>
                                            <textarea value={openrouterModels.join('\n')} onChange={handleOpenrouterModelsChange} rows={5}></textarea>
                                        </div>
                                    )}
                                     {selectedModel === 'groq' && (
                                        <div className="form-group">
                                            <label htmlFor="groq-model-select">Groq Model</label>
                                            <input type="text" id="groq-model-select" value={selectedGroqModel} onChange={e => setSelectedGroqModel(e.target.value)} placeholder="e.g., llama3-70b-8192" />
                                            <p className="help-text">Enter any model name compatible with the Groq API.</p>
                                        </div>
                                    )}
                                     <div className="form-group checkbox-group">
                                        <input type="checkbox" id="useGoogleSearch" checked={useGoogleSearch} onChange={e => setUseGoogleSearch(e.target.checked)} />
                                        <label htmlFor="useGoogleSearch">Enable Google Search Grounding</label>
                                    </div>
                                    <p className="help-text">Grounding provides the AI with real-time search results for more accurate, up-to-date content. Recommended for time-sensitive topics.</p>
                                </div>

                                <div className="setup-card full-width">
                                    <h3>WordPress & Site Information</h3>
                                    <div className="schema-settings-grid">
                                        <div className="form-group">
                                            <label htmlFor="wpUrl">WordPress Site URL</label>
                                            <input type="url" id="wpUrl" value={wpConfig.url} onChange={e => setWpConfig(p => ({...p, url: e.target.value}))} placeholder="https://example.com" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="wpUsername">WordPress Username</label>
                                            <input type="text" id="wpUsername" value={wpConfig.username} onChange={e => setWpConfig(p => ({...p, username: e.target.value}))} placeholder="your_username" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="wpPassword">WordPress Application Password</label>
                                            <input type="password" id="wpPassword" value={wpPassword} onChange={e => setWpPassword(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="orgName">Organization Name</label>
                                            <input type="text" id="orgName" value={siteInfo.orgName} onChange={e => setSiteInfo(p => ({...p, orgName: e.target.value}))} placeholder="My Awesome Blog" />
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="logoUrl">Logo URL</label>
                                            <input type="url" id="logoUrl" value={siteInfo.logoUrl} onChange={e => setSiteInfo(p => ({...p, logoUrl: e.target.value}))} placeholder="https://example.com/logo.png" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="authorName">Author Name</label>
                                            <input type="text" id="authorName" value={siteInfo.authorName} onChange={e => setSiteInfo(p => ({...p, authorName: e.target.value}))} placeholder="John Doe" />
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="authorUrl">Author Page URL</label>
                                            <input type="url" id="authorUrl" value={siteInfo.authorUrl} onChange={e => setSiteInfo(p => ({...p, authorUrl: e.target.value}))} placeholder="https://example.com/about-me" />
                                        </div>
                                    </div>
                                </div>
                                <div className="setup-card full-width">
                                    <h3>SOTA Image Publishing (Required for WordPress)</h3>
                                    <p className="help-text">This app uses a multi-layer fallback system for image uploads, ensuring they always succeed without requiring any manual PHP configuration on your server.</p>
                                    <div className="endpoint-status-container">
                                        <button className="btn-secondary" onClick={() => setIsEndpointModalOpen(true)}>Learn More</button>
                                        <button className="btn" onClick={verifyWpEndpoint} disabled={wpEndpointStatus === 'verifying'}>
                                            {wpEndpointStatus === 'verifying' ? 'Verifying...' : '✅ Auto-Detect Upload Method'}
                                        </button>
                                        <div className="key-status-icon">
                                            {wpEndpointStatus === 'verifying' && <div className="key-status-spinner"></div>}
                                            {wpEndpointStatus === 'valid' && <span className="success" title="REST API active!"><CheckIcon /> Active</span>}
                                            {wpEndpointStatus === 'invalid' && <span className="error" title="REST API not found or not working."><XIcon /> Inactive</span>}
                                        </div>
                                    </div>
                                </div>
                                
                                <div className="setup-card full-width">
                                    <h3>Advanced SEO Integrations (Neuro-Semantic)</h3>
                                    <p className="help-text">Connect NeuronWriter to fetch high-impact NLP terms. The AI will naturally weave these into the content to boost Content Scores.</p>
                                    
                                    <div className="form-group checkbox-group">
                                        <input 
                                            type="checkbox" 
                                            id="neuron-enabled" 
                                            checked={neuronConfig.enabled} 
                                            onChange={(e) => setNeuronConfig(p => ({...p, enabled: e.target.checked}))} 
                                        />
                                        <label htmlFor="neuron-enabled">Enable NeuronWriter Integration</label>
                                    </div>

                                    {neuronConfig.enabled && (
                                        <div className="schema-settings-grid">
                                            <div className="form-group">
                                                <label htmlFor="neuronApiKey">NeuronWriter API Key</label>
                                                <div className="api-key-group">
                                                    <input 
                                                        type="password" 
                                                        id="neuronApiKey" 
                                                        value={neuronConfig.apiKey} 
                                                        onChange={e => setNeuronConfig(p => ({...p, apiKey: e.target.value}))} 
                                                        placeholder="e.g., n-abc123..." 
                                                    />
                                                    {isFetchingNeuronProjects && <div className="key-status-spinner"></div>}
                                                    {neuronProjects.length > 0 && <span className="success" title="Projects loaded"><CheckIcon /></span>}
                                                    <button className="btn btn-small btn-secondary" onClick={() => fetchProjects(neuronConfig.apiKey)} disabled={isFetchingNeuronProjects}>
                                                        {isFetchingNeuronProjects ? 'Loading...' : 'Refresh'}
                                                    </button>
                                                </div>
                                                {neuronFetchError && <p className="error help-text" style={{color: 'var(--error)'}}>{neuronFetchError}</p>}
                                            </div>

                                            <div className="form-group">
                                                <label htmlFor="neuronProjectId">Project</label>
                                                {neuronProjects.length > 0 ? (
                                                    <select
                                                        id="neuronProjectId"
                                                        value={neuronConfig.projectId}
                                                        onChange={e => setNeuronConfig(p => ({...p, projectId: e.target.value}))}
                                                        style={{width: '100%', padding: '0.7rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 'var(--border-radius-md)'}}
                                                    >
                                                        <option value="">Select a project...</option>
                                                        {neuronProjects.map(p => (
                                                            <option key={p.project} value={p.project}>
                                                                {p.name} ({p.engine} - {p.language})
                                                            </option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input 
                                                        type="text" 
                                                        id="neuronProjectId" 
                                                        value={neuronConfig.projectId} 
                                                        onChange={e => setNeuronConfig(p => ({...p, projectId: e.target.value}))} 
                                                        placeholder={isFetchingNeuronProjects ? "Loading projects..." : "Enter API Key to load projects, or type ID manually"} 
                                                        disabled={isFetchingNeuronProjects}
                                                    />
                                                )}
                                                <p className="help-text">Projects are automatically fetched when you enter a valid API Key.</p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="setup-card full-width">
                                    <h3>Advanced Geo-Targeting</h3>
                                    <div className="form-group checkbox-group">
                                        <input type="checkbox" id="geo-enabled" checked={geoTargeting.enabled} onChange={(e) => setGeoTargeting(p => ({...p, enabled: e.target.checked}))} />
                                        <label htmlFor="geo-enabled">Enable Geo-Targeting for Content</label>
                                    </div>
                                    {geoTargeting.enabled && (
                                        <div className="schema-settings-grid">
                                            <input type="text" value={geoTargeting.location} onChange={e => setGeoTargeting(p => ({...p, location: e.target.value}))} placeholder="City (e.g., Austin)" />
                                            <input type="text" value={geoTargeting.region} onChange={e => setGeoTargeting(p => ({...p, region: e.target.value}))} placeholder="State/Region (e.g., TX)" />
                                            <input type="text" value={geoTargeting.country} onChange={e => setGeoTargeting(p => ({...p, country: e.target.value}))} placeholder="Country Code (e.g., US)" />
                                            <input type="text" value={geoTargeting.postalCode} onChange={e => setGeoTargeting(p => ({...p, postalCode: e.target.value}))} placeholder="Postal Code (e.g., 78701)" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                    {activeView === 'strategy' && (
                        <div className="content-strategy-view">
                             <div className="page-header">
                                <h2 className="gradient-headline">2. Content Strategy & Planning</h2>
                                <p>Choose your content creation method. Plan a full topic cluster, generate a single article from a keyword, or use the Content Hub to analyze and rewrite existing posts.</p>
                            </div>
                            <div className="tabs-container">
                                <div className="tabs" role="tablist">
                                    <button className={`tab-btn ${contentMode === 'bulk' ? 'active' : ''}`} onClick={() => setContentMode('bulk')} role="tab">Bulk Content Planner</button>
                                    <button className={`tab-btn ${contentMode === 'single' ? 'active' : ''}`} onClick={() => setContentMode('single')} role="tab">Single Article</button>
                                    <button className={`tab-btn ${contentMode === 'hub' ? 'active' : ''}`} onClick={() => setContentMode('hub')} role="tab">Content Hub</button>
                                    <button className={`tab-btn ${contentMode === 'imageGenerator' ? 'active' : ''}`} onClick={() => setContentMode('imageGenerator')} role="tab">Image Generator</button>
                                </div>
                            </div>
                            {contentMode === 'bulk' && (
                                <div className="tab-panel">
                                    <h3>Bulk Content Planner</h3>
                                    <p className="help-text">Enter a broad topic (e.g., "digital marketing") to generate a complete pillar page and cluster content plan, optimized for topical authority.</p>
                                    <div className="form-group">
                                        <label htmlFor="topic">Broad Topic</label>
                                        <input type="text" id="topic" value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g., Landscape Photography" />
                                    </div>
                                    <button className="btn" onClick={handleGenerateClusterPlan} disabled={isGenerating || !topic}>
                                        {isGenerating ? 'Generating...' : 'Generate Content Plan'}
                                    </button>
                                </div>
                            )}
                             {contentMode === 'single' && (
                                <div className="tab-panel">
                                    <h3>Single Article from Keyword</h3>
                                    <p className="help-text">Enter one or more specific primary keywords, each on a new line, to generate multiple articles at once.</p>
                                     <div className="form-group">
                                        <label htmlFor="primaryKeywords">Primary Keywords (one per line)</label>
                                        <textarea id="primaryKeywords" value={primaryKeywords} onChange={e => setPrimaryKeywords(e.target.value)} placeholder="e.g., best camera for landscape photography
how to edit photos in lightroom" rows={5}></textarea>
                                    </div>
                                    <button className="btn" onClick={handleGenerateMultipleFromKeywords} disabled={!primaryKeywords.trim()}>Go to Review &rarr;</button>
                                </div>
                            )}
                            {contentMode === 'hub' && (
                                 <div className="tab-panel">
                                    <h3>Content Hub & Rewrite Assistant</h3>
                                    <p className="help-text">Enter your sitemap URL to crawl your existing content. Analyze posts for SEO health and generate strategic rewrite plans.</p>
                                    <div className="sitemap-crawler-form">
                                        <div className="form-group">
                                             <label htmlFor="sitemapUrl">Sitemap URL</label>
                                             <input type="url" id="sitemapUrl" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} placeholder="https://example.com/sitemap_index.xml" />
                                        </div>
                                        <button className="btn" onClick={handleCrawlSitemap} disabled={isCrawling}>
                                            {isCrawling ? 'Crawling...' : 'Crawl Sitemap'}
                                        </button>
                                    </div>
                                    {crawlMessage && <div className="crawl-status">{crawlMessage}</div>}
                                    {existingPages.length > 0 && (
                                        <div className="content-hub-table-container">
                                            <div className="table-controls">
                                                <input type="search" placeholder="Search pages..." className="filter-input" value={hubSearchFilter} onChange={e => setHubSearchFilter(e.target.value)} />
                                                 <select value={hubStatusFilter} onChange={e => setHubStatusFilter(e.target.value)}>
                                                    <option value="All">All Statuses</option>
                                                    <option value="Critical">Critical</option>
                                                    <option value="High">High</option>
                                                    <option value="Medium">Medium</option>
                                                    <option value="Healthy">Healthy</option>
                                                </select>
                                                <div className="table-actions">
                                                    <button className="btn btn-secondary" onClick={handleAnalyzeSelectedPages} disabled={isAnalyzingHealth || selectedHubPages.size === 0}>
                                                        {isAnalyzingHealth ? `Analyzing... (${healthAnalysisProgress.current}/${healthAnalysisProgress.total})` : `Analyze Selected (${selectedHubPages.size})`}
                                                    </button>
                                                    <button className="btn" onClick={handleRewriteSelected} disabled={analyzableForRewrite === 0}>Rewrite Selected ({analyzableForRewrite})</button>
                                                </div>
                                            </div>
                                            <table className="content-hub-table">
                                                <thead>
                                                    <tr>
                                                        <th><input type="checkbox" onChange={handleToggleHubPageSelectAll} checked={selectedHubPages.size > 0 && selectedHubPages.size === filteredAndSortedHubPages.length} /></th>
                                                        <th onClick={() => handleHubSort('title')}>Title & Slug</th>
                                                        <th onClick={() => handleHubSort('daysOld')}>Age</th>
                                                        <th onClick={() => handleHubSort('updatePriority')}>Status</th>
                                                         <th>Analysis & Actions</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                {isCrawling ? <SkeletonLoader rows={10} columns={5} /> : filteredAndSortedHubPages.map(page => (
                                                        <tr key={page.id}>
                                                            <td><input type="checkbox" checked={selectedHubPages.has(page.id)} onChange={() => handleToggleHubPageSelect(page.id)} /></td>
                                                            <td className="hub-title-cell">
                                                                <a href={page.id} target="_blank" rel="noopener noreferrer">{sanitizeTitle(page.title, page.slug)}</a>
                                                                <div className="slug">{page.id}</div>
                                                            </td>
                                                            <td>{page.daysOld !== null ? `${page.daysOld} days` : 'N/A'}</td>
                                                            <td><div className="status-cell">{page.updatePriority ? <span className={`priority-${page.updatePriority}`}>{page.updatePriority}</span> : 'Not Analyzed'}</div></td>
                                                            <td>
                                                               {page.status === 'analyzing' && <div className="status-cell"><div className="status-indicator analyzing"></div>Analyzing...</div>}
                                                                {page.status === 'error' && <div className="status-cell"><div className="status-indicator error"></div>Error</div>}
                                                                {page.status === 'analyzed' && page.analysis && (
                                                                    <button className="btn btn-small" onClick={() => setViewingAnalysis(page)}>View Rewrite Plan</button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )}
                             {contentMode === 'imageGenerator' && (
                                <div className="tab-panel">
                                    <h3>SOTA Image Generator</h3>
                                    <p className="help-text">Generate high-quality images for your content using DALL-E 3 or Gemini Imagen. Describe the image you want in detail.</p>
                                    <div className="form-group">
                                        <label htmlFor="imagePrompt">Image Prompt</label>
                                        <textarea id="imagePrompt" value={imagePrompt} onChange={e => setImagePrompt(e.target.value)} rows={4} placeholder="e.g., A photorealistic image of a golden retriever puppy playing in a field of flowers, cinematic lighting, 16:9 aspect ratio." />
                                    </div>
                                    <div className="form-group-row">
                                        <div className="form-group">
                                            <label htmlFor="numImages">Number of Images</label>
                                            <select id="numImages" value={numImages} onChange={e => setNumImages(Number(e.target.value))}>
                                                {[1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
                                            </select>
                                        </div>
                                         <div className="form-group">
                                            <label htmlFor="aspectRatio">Aspect Ratio</label>
                                            <select id="aspectRatio" value={aspectRatio} onChange={e => setAspectRatio(e.target.value)}>
                                                <option value="1:1">1:1 (Square)</option>
                                                <option value="16:9">16:9 (Widescreen)</option>
                                                <option value="9:16">9:16 (Vertical)</option>
                                                <option value="4:3">4:3 (Landscape)</option>
                                                <option value="3:4">3:4 (Portrait)</option>
                                            </select>
                                        </div>
                                    </div>
                                    <button className="btn" onClick={handleGenerateImages} disabled={isGeneratingImages || !imagePrompt}>
                                        {isGeneratingImages ? <><div className="spinner"></div> Generating...</> : 'Generate Images'}
                                    </button>
                                    {imageGenerationError && <p className="error" style={{marginTop: '1rem'}}>{imageGenerationError}</p>}
                                    {generatedImages.length > 0 && (
                                        <div className="image-assets-grid" style={{marginTop: '2rem'}}>
                                            {generatedImages.map((image, index) => (
                                                <div key={index} className="image-asset-card">
                                                    <img src={image.src} alt={image.prompt} loading="lazy" />
                                                    <div className="image-asset-details">
                                                        <button className="btn btn-small" onClick={() => handleDownloadImage(image.src, image.prompt)}>Download</button>
                                                        <button className="btn btn-small btn-secondary" onClick={() => handleCopyText(image.prompt)}>Copy Prompt</button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {activeView === 'review' && (
                        <div className="review-export-view">
                            <div className="page-header">
                                <h2 className="gradient-headline">3. Review & Export</h2>
                                <p>Review your generated content, check SEO scores, edit as needed, and publish directly to WordPress.</p>
                            </div>
                             <div className="table-controls">
                                <input type="search" placeholder="Filter content..." className="filter-input" value={filter} onChange={e => setFilter(e.target.value)} />
                                <div className="table-actions">
                                    <button className="btn" onClick={handleGenerateSelected} disabled={isGenerating || selectedItems.size === 0}>
                                        {isGenerating ? `Generating... (${generationProgress.current}/${generationProgress.total})` : `Generate Selected (${selectedItems.size})`}
                                    </button>
                                    {isGenerating && <button className="btn btn-secondary" onClick={() => handleStopGeneration()}>Stop All</button>}
                                    <button className="btn btn-secondary" onClick={() => setIsBulkPublishModalOpen(true)} disabled={selectedItems.size === 0}>
                                        Bulk Publish ({selectedItems.size})
                                    </button>
                                </div>
                            </div>
                            <div className="review-table-container">
                                <table className="review-table">
                                    <thead>
                                        <tr>
                                            <th><input type="checkbox" onChange={handleToggleSelectAll} checked={selectedItems.size > 0 && selectedItems.size === filteredAndSortedItems.length} /></th>
                                            <th onClick={() => handleSort('title')}>Title</th>
                                            <th onClick={() => handleSort('type')}>Type</th>
                                            <th onClick={() => handleSort('status')}>Status</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredAndSortedItems.length === 0 ? (
                                             <tr>
                                                <td colSpan={5} style={{textAlign: 'center', padding: '2rem', color: 'var(--text-tertiary)'}}>
                                                    No content items yet. Go to "Content Strategy" to plan some articles.
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredAndSortedItems.map(item => (
                                                <tr key={item.id}>
                                                    <td><input type="checkbox" checked={selectedItems.has(item.id)} onChange={() => handleToggleSelect(item.id)} /></td>
                                                    <td>{item.title}</td>
                                                    <td><span className={`badge ${item.type}`}>{item.type}</span></td>
                                                    <td>
                                                        <div className="status-cell">
                                                            {/* SOTA FIX: Visually distinguish 'warning' errors (like word count) from hard errors */}
                                                            <div 
                                                                className={`status-indicator ${item.status}`} 
                                                                style={(item.status === 'error' && item.statusText.includes('TOO SHORT')) ? { backgroundColor: 'var(--warning)' } : {}}
                                                            ></div>
                                                            {item.statusText}
                                                        </div>
                                                    </td>
                                                    <td>
                                                        {item.status === 'idle' && <button className="btn btn-small" onClick={() => handleGenerateSingle(item)}>Generate</button>}
                                                        {item.status === 'generating' && <button className="btn btn-small btn-secondary" onClick={() => handleStopGeneration(item.id)}>Stop</button>}
                                                        
                                                        {/* SOTA FIX: Allow reviewing content even if marked as error (e.g., word count fail), as long as content exists */}
                                                        {(item.status === 'done' || (item.status === 'error' && item.generatedContent)) && (
                                                            <button className="btn btn-small" onClick={() => setSelectedItemForReview(item)}>Review</button>
                                                        )}
                                                        
                                                        {item.status === 'error' && (
                                                            <button 
                                                                className="btn btn-small btn-secondary" 
                                                                onClick={() => handleGenerateSingle(item)}
                                                                style={item.generatedContent ? { marginLeft: '0.5rem' } : {}}
                                                            >
                                                                Retry
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </main>
            </div>
            <AppFooter />
            
            {/* Modals */}
            {isEndpointModalOpen && (
                <WordPressEndpointInstructions onClose={() => setIsEndpointModalOpen(false)} />
            )}
            {selectedItemForReview && (
                <ReviewModal 
                    item={selectedItemForReview} 
                    onClose={() => setSelectedItemForReview(null)}
                    onSaveChanges={(itemId, updatedSeo, updatedContent) => {
                        dispatch({
                            type: 'SET_CONTENT',
                            payload: { 
                                id: itemId, 
                                content: { 
                                    ...selectedItemForReview.generatedContent!, 
                                    title: updatedSeo.title, 
                                    metaDescription: updatedSeo.metaDescription, 
                                    slug: extractSlugFromUrl(updatedSeo.slug),
                                    content: updatedContent 
                                } 
                            } 
                        });
                        // Update the list title as well for consistency
                        const updatedItem = items.find(i => i.id === itemId);
                        if(updatedItem && updatedItem.title !== updatedSeo.title){
                             // We need a way to update the item title in the list, 
                             // dispatch SET_ITEMS effectively overwrites, which isn't ideal for a single update.
                             // For now, we rely on the content being updated.
                        }
                        alert('Changes saved locally!');
                    }}
                    wpConfig={wpConfig}
                    wpPassword={wpPassword}
                    onPublishSuccess={(originalUrl) => {
                         // If it was an update, maybe refresh the status or similar
                         console.log(`Successfully updated: ${originalUrl}`);
                    }}
                    publishItem={(item, pwd, status) => publishItemToWordPress(item, pwd, status, fetchWordPressWithRetry, wpConfig)}
                    callAI={(key, args, fmt, g) => callAI(apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, key, args, fmt, g)}
                    geoTargeting={geoTargeting}
                    neuronConfig={neuronConfig} // SOTA FIX: Pass NeuronConfig to modal for UI visibility
                />
            )}
            {isBulkPublishModalOpen && (
                <BulkPublishModal 
                    items={items.filter(i => selectedItems.has(i.id) && i.status === 'done')}
                    onClose={() => setIsBulkPublishModalOpen(false)}
                    publishItem={(item, pwd, status) => publishItemToWordPress(item, pwd, status, fetchWordPressWithRetry, wpConfig)}
                    wpConfig={wpConfig}
                    wpPassword={wpPassword}
                    onPublishSuccess={(url) => console.log(`Published ${url}`)}
                />
            )}
             {viewingAnalysis && (
                <AnalysisModal 
                    page={viewingAnalysis} 
                    onClose={() => setViewingAnalysis(null)} 
                    onPlanRewrite={handlePlanRewrite} 
                />
            )}
        </div>
    );
};

export default App;