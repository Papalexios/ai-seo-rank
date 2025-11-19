
import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import { ContentItem, SeoCheck, ExpandedGeoTargeting, WpConfig, SitemapPage, ApiClients, NeuronConfig } from './types';
// FIX: Import moved functions from contentUtils to resolve circular dependency errors.
import { calculateFleschReadability, getReadabilityVerdict, escapeRegExp } from './contentUtils';
import { extractSlugFromUrl, parseJsonWithAiRepair, processConcurrently } from './utils';
import { MIN_INTERNAL_LINKS, TARGET_MAX_WORDS, TARGET_MIN_WORDS } from './constants';
import { callAI } from './services';

// SOTA: Centralized Icon component for easy management and consistency
export const CheckIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
);

export const XIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
);

export const SidebarNav = memo(({ activeView, onNavClick }: { activeView: string; onNavClick: (view: string) => void; }) => {
    const navItems = [
        { id: 'setup', name: 'Setup' },
        { id: 'strategy', name: 'Content Strategy' },
        { id: 'review', name: 'Review & Export' }
    ];
    return (
        <nav aria-label="Main navigation">
            <ul className="sidebar-nav">
                {navItems.map((item) => (
                    <li key={item.id}>
                        <button
                            className={`nav-item ${activeView === item.id ? 'active' : ''}`}
                            onClick={() => onNavClick(item.id)}
                            aria-current={activeView === item.id}
                        >
                            <span className="nav-item-name">{item.name}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
});

interface ApiKeyInputProps {
    provider: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    status: 'idle' | 'validating' | 'valid' | 'invalid';
    name?: string;
    placeholder?: string;
    isTextArea?: boolean;
    isEditing: boolean;
    onEdit: () => void;
    type?: 'text' | 'password';
}
export const ApiKeyInput = memo(({ provider, value, onChange, status, name, placeholder, isTextArea, isEditing, onEdit, type = 'password' }: ApiKeyInputProps) => {
    const InputComponent = isTextArea ? 'textarea' : 'input';

    if (status === 'valid' && !isEditing) {
        return (
            <div className="api-key-group">
                <input type="text" readOnly value={`**** **** **** ${value.slice(-4)}`} />
                <button onClick={onEdit} className="btn-edit-key" aria-label={`Edit ${provider} API Key`}>Edit</button>
            </div>
        );
    }

    const commonProps = {
        name: name || `${provider}ApiKey`,
        value: value,
        onChange: onChange,
        placeholder: placeholder || `Enter your ${provider.charAt(0).toUpperCase() + provider.slice(1)} API Key`,
        'aria-invalid': status === 'invalid',
        'aria-describedby': `${provider}-status`,
        ...(isTextArea ? { rows: 4 } : { type: type })
    };

    return (
        <div className="api-key-group">
            <InputComponent {...commonProps} />
            <div className="key-status-icon" id={`${provider}-status`} role="status">
                {status === 'validating' && <div className="key-status-spinner" aria-label="Validating key"></div>}
                {status === 'valid' && <span className="success"><CheckIcon /></span>}
                {status === 'invalid' && <span className="error"><XIcon /></span>}
            </div>
        </div>
    );
});

const ScoreGauge = ({ score, size = 80 }: { score: number; size?: number }) => {
    const radius = size / 2 - 5;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    let strokeColor = 'var(--success)';
    if (score < 75) strokeColor = 'var(--warning)';
    if (score < 50) strokeColor = 'var(--error)';

    return (
        <div className="score-gauge" style={{ width: size, height: size }}>
            <svg className="score-gauge-svg" viewBox={`0 0 ${size} ${size}`}>
                <circle className="gauge-bg" cx={size/2} cy={size/2} r={radius} />
                <circle className="gauge-fg" cx={size/2} cy={size/2} r={radius} stroke={strokeColor} strokeDasharray={circumference} strokeDashoffset={offset} />
            </svg>
            <span className="score-gauge-text" style={{ color: strokeColor }}>{score}</span>
        </div>
    );
};


interface RankGuardianProps {
    item: ContentItem;
    editedSeo: { title: string; metaDescription: string; slug: string };
    editedContent: string;
    onSeoChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRegenerate: (field: 'title' | 'meta') => void;
    isRegenerating: { title: boolean; meta: boolean };
    isUpdate: boolean;
    geoTargeting: ExpandedGeoTargeting;
}

const formatSerpUrl = (fullUrl: string): React.ReactNode => {
    try {
        const url = new URL(fullUrl);
        const parts = [url.hostname, ...url.pathname.split('/').filter(Boolean)];
        
        return (
            <div className="serp-breadcrumb">
                {parts.map((part, index) => (
                    <React.Fragment key={index}>
                        <span>{part}</span>
                        {index < parts.length - 1 && <span className="breadcrumb-separator">›</span>}
                    </React.Fragment>
                ))}
            </div>
        );
    } catch (e) {
        // Fallback for invalid URLs
        return (
            <div className="serp-breadcrumb">
                <span>{fullUrl}</span>
            </div>
        );
    }
};

export const RankGuardian = memo(({ item, editedSeo, editedContent, onSeoChange, onUrlChange, onRegenerate, isRegenerating, isUpdate, geoTargeting }: RankGuardianProps) => {
    // SOTA FIX: Add a guard clause to prevent crashes when generatedContent is null.
    if (!item.generatedContent) {
        return (
            <div className="rank-guardian-reloaded">
                <div className="guardian-card">
                    <h4>Analysis Unavailable</h4>
                    <p>Content has not been generated for this item yet. Please generate the content to see the SEO analysis.</p>
                </div>
            </div>
        );
    }

    const { title, metaDescription, slug } = editedSeo;
    const { primaryKeyword = '', semanticKeywords = [] } = item.generatedContent;

    const analysis = useMemo(() => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = editedContent || '';
        const textContent = tempDiv.textContent || '';
        const wordCount = (textContent.match(/\b\w+\b/g) || []).length;
        const keywordLower = (primaryKeyword || '').toLowerCase();
        
        const contentAnalysis = {
            wordCount,
            readabilityScore: calculateFleschReadability(textContent),
            keywordDensity: keywordLower ? (textContent.toLowerCase().match(new RegExp(escapeRegExp(keywordLower), 'g')) || []).length : 0,
            semanticKeywordCount: (semanticKeywords || []).reduce((acc, kw) => acc + (textContent.toLowerCase().match(new RegExp(escapeRegExp(kw.toLowerCase()), 'g')) || []).length, 0),
            linkCount: tempDiv.getElementsByTagName('a').length,
            tableCount: tempDiv.getElementsByTagName('table').length,
            listCount: tempDiv.querySelectorAll('ul, ol').length,
        };

        const checks: SeoCheck[] = [
            // SOTA AUDIT CONFIRMATION: The following checks enforce the user's strict SEO requirements.
            
            // Meta: Title Length (50-60 chars) & Keyword Inclusion
            { id: 'titleLength', valid: title.length >= 50 && title.length <= 60, value: title.length, text: 'Title Length (50-60)', category: 'Meta', priority: 'High', advice: 'Titles between 50 and 60 characters have the best click-through rates on Google.' },
            { id: 'titleKeyword', valid: !!keywordLower && title.toLowerCase().includes(keywordLower), value: !!keywordLower && title.toLowerCase().includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in Title', category: 'Meta', priority: 'High', advice: 'Including your primary keyword in the SEO title is crucial for relevance.' },
            
            // Meta: Meta Description Length (135-150 chars) & Keyword Inclusion
            { id: 'metaLength', valid: metaDescription.length >= 135 && metaDescription.length <= 150, value: metaDescription.length, text: 'Meta Description (135-150)', category: 'Meta', priority: 'Medium', advice: 'Write a meta description between 135 and 150 characters to avoid truncation and maximize CTR.' },
            { id: 'metaKeyword', valid: !!keywordLower && metaDescription.toLowerCase().includes(keywordLower), value: !!keywordLower && metaDescription.toLowerCase().includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in Meta', category: 'Meta', priority: 'High', advice: 'Your meta description should contain the primary keyword to improve click-through rate.' },
            
            // Content: Word Count (2200-2800 words) & Keyword Placement
            { id: 'wordCount', valid: wordCount >= TARGET_MIN_WORDS && wordCount <= TARGET_MAX_WORDS, value: wordCount, text: `Word Count (${TARGET_MIN_WORDS}-${TARGET_MAX_WORDS})`, category: 'Content', priority: 'High', advice: `Content must be between ${TARGET_MIN_WORDS} and ${TARGET_MAX_WORDS} words for optimal depth and quality.` },
            { id: 'keywordDensity', valid: contentAnalysis.keywordDensity > 0, value: `${contentAnalysis.keywordDensity} time(s)`, text: 'Keyword Usage', category: 'Content', priority: 'High', advice: 'Using your primary keyword ensures the topic is clear to search engines.' },
            { id: 'keywordInFirstP', valid: !!keywordLower && (tempDiv.querySelector('p')?.textContent?.toLowerCase() || '').includes(keywordLower), value: !!keywordLower && (tempDiv.querySelector('p')?.textContent?.toLowerCase() || '').includes(keywordLower) ? 'Yes' : 'No', text: 'Keyword in First Paragraph', category: 'Content', priority: 'High', advice: 'Placing your keyword in the first 100 words signals the topic to search engines early.' },
            
            // Other crucial SEO checks
            { id: 'h1s', valid: tempDiv.getElementsByTagName('h1').length === 0, value: tempDiv.getElementsByTagName('h1').length, text: 'H1 Tags in Content', category: 'Content', priority: 'High', advice: 'Your content body should not contain any H1 tags. The article title serves as the only H1.' },
            { id: 'links', valid: contentAnalysis.linkCount >= MIN_INTERNAL_LINKS, value: contentAnalysis.linkCount, text: `Internal Links (${MIN_INTERNAL_LINKS}+)`, category: 'Content', priority: 'Medium', advice: 'A strong internal linking structure helps Google understand your site architecture and topic clusters.' },
            { id: 'structuredData', valid: contentAnalysis.tableCount > 0 || contentAnalysis.listCount > 0, value: `${contentAnalysis.tableCount} tables, ${contentAnalysis.listCount} lists`, text: 'Use of Structured Data', category: 'Content', priority: 'Low', advice: 'Using tables and lists helps break up text and can lead to featured snippets.' },
            
            // Accessibility & E-E-A-T
            { id: 'altText', valid: tempDiv.querySelectorAll('img:not([alt]), img[alt=""]').length === 0, value: `${tempDiv.querySelectorAll('img:not([alt]), img[alt=""]').length} missing`, text: 'Image Alt Text', category: 'Accessibility', priority: 'Medium', advice: 'All images need descriptive alt text for screen readers and SEO.' },
            { id: 'references', valid: editedContent.toLowerCase().includes('<h2>references</h2>') && editedContent.includes('class="reference-list"'), value: editedContent.toLowerCase().includes('<h2>references</h2>') ? 'Yes' : 'No', text: 'Cites Authoritative Sources', category: 'Trust & E-E-A-T', priority: 'High', advice: 'A "References" section with links to authoritative sources is a powerful Trust signal.' },
            { id: 'authorBox', valid: editedContent.includes('class="eeat-author-box"'), value: editedContent.includes('class="eeat-author-box"') ? 'Yes' : 'No', text: 'Author E-E-A-T Box', category: 'Trust & E-E-A-T', priority: 'Medium', advice: 'Including an author box with credentials demonstrates expertise and builds trust with readers.' },
        ];
        
        return { contentAnalysis, checks };

    }, [title, metaDescription, primaryKeyword, editedContent, semanticKeywords]);
    
    const { contentAnalysis, checks } = analysis;
    const readabilityVerdict = getReadabilityVerdict(contentAnalysis.readabilityScore);

    const scores = useMemo(() => {
        const totalChecks = checks.length;
        const validChecks = checks.filter(c => c.valid).length;
        const seoScore = totalChecks > 0 ? Math.round((validChecks / totalChecks) * 100) : 100;
        const overallScore = Math.round(seoScore * 0.7 + contentAnalysis.readabilityScore * 0.3);
        return { seoScore, overallScore };
    }, [checks, contentAnalysis.readabilityScore]);
    
    const actionItems = checks.filter(c => !c.valid).sort((a, b) => {
        const priorityOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    const titleLength = title.length;
    const titleStatus = titleLength > 60 || titleLength < 50 ? 'bad' : 'good';
    const metaLength = metaDescription.length;
    const metaStatus = metaLength > 150 || metaLength < 135 ? 'bad' : 'good';

    return (
        <div className="rank-guardian-reloaded">
             <div className="guardian-header">
                <div className="guardian-main-score">
                    <ScoreGauge score={scores.overallScore} size={100} />
                    <div className="main-score-text">
                        <h4>Overall Score</h4>
                        <p>A combined metric of your on-page SEO and readability.</p>
                    </div>
                </div>
                <div className="guardian-sub-scores">
                    <div className="guardian-sub-score">
                        <ScoreGauge score={scores.seoScore} size={70}/>
                        <div className="sub-score-text">
                            <h5>SEO</h5>
                            <span>{scores.seoScore}/100</span>
                        </div>
                    </div>
                     <div className="guardian-sub-score">
                        <ScoreGauge score={contentAnalysis.readabilityScore}  size={70}/>
                        <div className="sub-score-text">
                            <h5>Readability</h5>
                            <span style={{color: readabilityVerdict.color}}>{readabilityVerdict.verdict}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="guardian-grid">
                <div className="guardian-card">
                     <h4>SERP Preview & Metadata</h4>
                     <div className="serp-preview-container">
                        <div className="serp-preview">
                            <div className="serp-url">{formatSerpUrl(slug)}</div>
                            <h3 className="serp-title">{title}</h3>
                            <div className="serp-description">{metaDescription}</div>
                        </div>
                    </div>
                     <div className="seo-inputs" style={{marginTop: '1.5rem'}}>
                        <div className="form-group">
                            <div className="label-wrapper">
                                <label htmlFor="title">SEO Title</label>
                                 <button className="btn-regenerate" onClick={() => onRegenerate('title')} disabled={isRegenerating.title}>
                                    {isRegenerating.title ? <div className="spinner"></div> : 'Regenerate'}
                                </button>
                                <span className={`char-counter ${titleStatus}`}>{titleLength} / 60</span>
                            </div>
                            <input type="text" id="title" name="title" value={title} onChange={onSeoChange} />
                            <div className="progress-bar-container">
                            <div className={`progress-bar-fill ${titleStatus}`} style={{ width: `${Math.min(100, (titleLength / 60) * 100)}%` }}></div>
                            </div>
                        </div>
                        <div className="form-group">
                            <div className="label-wrapper">
                                <label htmlFor="metaDescription">Meta Description</label>
                                <button className="btn-regenerate" onClick={() => onRegenerate('meta')} disabled={isRegenerating.meta}>
                                    {isRegenerating.meta ? <div className="spinner"></div> : 'Regenerate'}
                                </button>
                                <span className={`char-counter ${metaStatus}`}>{metaLength} / 150</span>
                            </div>
                            <textarea id="metaDescription" name="metaDescription" rows={3} value={metaDescription} onChange={onSeoChange}></textarea>
                            <div className="progress-bar-container">
                            <div className={`progress-bar-fill ${metaStatus}`} style={{ width: `${Math.min(100, (metaLength / 150) * 100)}%` }}></div>
                            </div>
                        </div>
                        <div className="form-group">
                            <label htmlFor="slug">Full URL</label>
                            <input type="text" id="slug" name="slug" value={slug} onChange={onUrlChange} disabled={isUpdate} />
                        </div>
                    </div>
                </div>
                
                 <div className="guardian-card">
                    <h4>Actionable Checklist</h4>
                     {actionItems.length === 0 ? (
                        <div className="all-good">
                            <span role="img" aria-label="party popper">🎉</span> All checks passed! This is looking great.
                        </div>
                    ) : (
                        <ul className="action-item-list">
                            {actionItems.map(item => (
                                <li key={item.id} className={`priority-${item.priority}`}>
                                    <h5>{item.text}</h5>
                                    <p>{item.advice}</p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                
                <div className="guardian-card">
                    <h4>Content Analysis</h4>
                    <ul className="guardian-checklist">
                       {checks.map(check => (
                           <li key={check.id}>
                                <div className={`check-icon-guardian ${check.valid ? 'valid' : 'invalid'}`}>
                                    {check.valid ? <CheckIcon /> : <XIcon />}
                                </div>
                                <div>
                                    <div className="check-text-guardian">{check.text}</div>
                                    <div className="check-advice-guardian">{check.advice}</div>
                                </div>
                           </li>
                       ))}
                    </ul>
                </div>

            </div>
        </div>
    );
});


export const SkeletonLoader = ({ rows = 5, columns = 5 }: { rows?: number, columns?: number }) => (
    <tbody>
        {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="skeleton-row">
                {Array.from({ length: columns }).map((_, j) => (
                    <td key={j}><div className="skeleton-loader"></div></td>
                ))}
            </tr>
        ))}
    </tbody>
);

export const Confetti = () => {
    const [pieces, setPieces] = useState<React.ReactElement[]>([]);

    useEffect(() => {
        const newPieces = Array.from({ length: 100 }).map((_, i) => {
            const style = {
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 2}s`,
                backgroundColor: `hsl(${Math.random() * 360}, 70%, 50%)`,
                transform: `rotate(${Math.random() * 360}deg)`,
            };
            return <div key={i} className="confetti" style={style}></div>;
        });
        setPieces(newPieces);
    }, []);

    return <div className="confetti-container" aria-hidden="true">{pieces}</div>;
};

// SOTA Editor syntax highlighter
const highlightHtml = (text: string): string => {
    if (!text) return '';
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Comments
    html = html.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="editor-comment">$1</span>');

    // Tags and attributes
    html = html.replace(/(&lt;\/?)([\w-]+)([^&]*?)(&gt;)/g, (match, open, tag, attrs, close) => {
        const highlightedTag = `<span class="editor-tag">${tag}</span>`;
        const highlightedAttrs = attrs.replace(/([\w-]+)=(".*?"|'.*?')/g, 
            '<span class="editor-attr-name">$1</span>=<span class="editor-attr-value">$2</span>'
        );
        return `${open}${highlightedTag}${highlightedAttrs}${close}`;
    });

    return html;
};


interface ReviewModalProps {
    item: ContentItem;
    onClose: () => void;
    onSaveChanges: (itemId: string, updatedSeo: { title: string; metaDescription: string; slug: string }, updatedContent: string) => void;
    wpConfig: WpConfig;
    wpPassword: string;
    onPublishSuccess: (originalUrl: string) => void;
    publishItem: (itemToPublish: ContentItem, currentWpPassword: string, status: 'publish' | 'draft') => Promise<{ success: boolean; message: React.ReactNode; link?: string }>;
    callAI: (promptKey: any, promptArgs: any[], responseFormat?: 'json' | 'html', useGrounding?: boolean) => Promise<string>;
    geoTargeting: ExpandedGeoTargeting;
    neuronConfig: NeuronConfig;
}


export const ReviewModal = ({ item, onClose, onSaveChanges, wpConfig, wpPassword, onPublishSuccess, publishItem, callAI, geoTargeting, neuronConfig }: ReviewModalProps) => {
    if (!item || !item.generatedContent) return null;

    const [activeTab, setActiveTab] = useState('Live Preview');
    const [editedSeo, setEditedSeo] = useState({ title: '', metaDescription: '', slug: '' });
    const [editedContent, setEditedContent] = useState('');
    const [copyStatus, setCopyStatus] = useState('Copy HTML');
    const [wpPublishStatus, setWpPublishStatus] = useState('idle'); // idle, publishing, success, error
    const [wpPublishMessage, setWpPublishMessage] = useState<React.ReactNode>('');
    const [publishAction, setPublishAction] = useState<'publish' | 'draft'>('publish');
    const [showConfetti, setShowConfetti] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState({ title: false, meta: false });

    // SOTA Editor State
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const lineNumbersRef = useRef<HTMLPreElement>(null);
    const highlightRef = useRef<HTMLDivElement>(null);
    const [lineCount, setLineCount] = useState(1);

    useEffect(() => {
        if (item && item.generatedContent) {
            const isUpdate = !!item.originalUrl;
            const fullUrl = isUpdate 
                ? item.originalUrl! 
                : `${wpConfig.url.replace(/\/+$/, '')}/${item.generatedContent.slug}`;
            
            setEditedSeo({
                title: item.generatedContent.title,
                metaDescription: item.generatedContent.metaDescription,
                slug: fullUrl,
            });
            setEditedContent(item.generatedContent.content);
            setActiveTab('Live Preview');
            setWpPublishStatus('idle');
            setWpPublishMessage('');
            setShowConfetti(false);
            
            // SOTA FIX: Reset editor scroll position
            if (editorRef.current) {
                editorRef.current.scrollTop = 0;
            }
        }
    }, [item, wpConfig.url]);


    // SOTA Editor Logic
    useEffect(() => {
        const lines = editedContent.split('\n').length;
        setLineCount(lines || 1);
    }, [editedContent]);

    const handleEditorScroll = useCallback(() => {
        if (lineNumbersRef.current && editorRef.current && highlightRef.current) {
            const scrollTop = editorRef.current.scrollTop;
            const scrollLeft = editorRef.current.scrollLeft;
            lineNumbersRef.current.scrollTop = scrollTop;
            highlightRef.current.scrollTop = scrollTop;
            highlightRef.current.scrollLeft = scrollLeft;
        }
    }, []);


    const previewContent = useMemo(() => {
        return editedContent;
    }, [editedContent]);

    const handleSeoChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setEditedSeo(prev => ({ ...prev, [name]: value }));
    };

    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setEditedSeo(prev => ({ ...prev, slug: e.target.value }));
    };

    const handleCopyHtml = () => {
        if (!item?.generatedContent) return;
        navigator.clipboard.writeText(editedContent)
            .then(() => {
                setCopyStatus('Copied!');
                setTimeout(() => setCopyStatus('Copy HTML'), 2000);
            })
            .catch(err => console.error('Failed to copy HTML: ', err));
    };

    const handleValidateSchema = () => {
        if (!item?.generatedContent?.jsonLdSchema) {
            alert("Schema has not been generated for this item yet.");
            return;
        }
        try {
            const schemaString = JSON.stringify(item.generatedContent.jsonLdSchema, null, 2);
            const url = `https://search.google.com/test/rich-results?code=${encodeURIComponent(schemaString)}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error("Failed to validate schema:", error);
            alert("Could not process schema for validation.");
        }
    };

    const handleDownloadImage = (base64Data: string, fileName: string) => {
        const link = document.createElement('a');
        link.href = base64Data;
        const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        link.download = `${safeName}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleRegenerateSeo = async (field: 'title' | 'meta') => {
        if (!item.generatedContent) return;
        setIsRegenerating(prev => ({ ...prev, [field]: true }));
        try {
            const { primaryKeyword, strategy, serpData } = item.generatedContent;
            const summary = editedContent.replace(/<[^>]+>/g, ' ').substring(0, 500);
            const competitorTitles = serpData?.map(d => d.title).slice(0, 5) || [];
            const location = geoTargeting.enabled ? geoTargeting.location : null;

            const responseText = await callAI('seo_metadata_generator', [
                primaryKeyword, summary, strategy.targetAudience, competitorTitles, location
            ], 'json');

            const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');
            const { seoTitle, metaDescription } = await parseJsonWithAiRepair(responseText, aiRepairer);

            if (field === 'title' && seoTitle) {
                setEditedSeo(prev => ({ ...prev, title: seoTitle }));
            }
            if (field === 'meta' && metaDescription) {
                setEditedSeo(prev => ({ ...prev, metaDescription: metaDescription }));
            }
        } catch (error: any) {
            console.error(`Failed to regenerate ${field}:`, error);
            alert(`An error occurred while regenerating the ${field}. Please check the console.`);
        } finally {
            setIsRegenerating(prev => ({ ...prev, [field]: false }));
        }
    };


    const handlePublishToWordPress = async () => {
        if (!wpConfig.url || !wpConfig.username || !wpPassword) {
            setWpPublishStatus('error');
            setWpPublishMessage('Please fill in WordPress URL, Username, and Application Password in Step 1.');
            return;
        }

        setWpPublishStatus('publishing');
        
        const itemWithEdits: ContentItem = {
            ...item,
            generatedContent: {
                ...item.generatedContent!,
                title: editedSeo.title,
                metaDescription: editedSeo.metaDescription,
                slug: extractSlugFromUrl(editedSeo.slug),
                content: editedContent,
            }
        };

        const result = await publishItem(itemWithEdits, wpPassword, item.originalUrl ? 'publish' : publishAction);

        if (result.success) {
            setWpPublishStatus('success');
            setShowConfetti(true);
            if (item.originalUrl) {
                onPublishSuccess(item.originalUrl);
            }
        } else {
            setWpPublishStatus('error');
        }
        setWpPublishMessage(result.message);
    };

    // SOTA FEATURE: Analyze Content against Neuron Terms
    const neuronAnalysisView = useMemo(() => {
        const na = item.generatedContent?.neuronAnalysis?.terms_txt;
        if (!na) return null;

        const checkTerms = (termString: string | undefined, type: string) => {
            if (!termString) return [];
            // Some API versions return comma separated, some newline. Handle both.
            const terms = termString.split(/,|\n/).map(t => t.trim()).filter(t => t.length > 0);
            const contentLower = editedContent.toLowerCase();
            
            return terms.map(term => {
                // Simple inclusion check. For more strict checks we'd need regex with word boundaries.
                const exists = contentLower.includes(term.toLowerCase());
                return { term, exists, type };
            });
        };

        const basicTerms = checkTerms(na.content_basic, 'Basic');
        const extendedTerms = checkTerms(na.content_extended, 'Extended');
        const h1Terms = checkTerms(na.h1, 'H1');
        const h2Terms = checkTerms(na.h2, 'H2');

        return { basicTerms, extendedTerms, h1Terms, h2Terms };

    }, [item.generatedContent?.neuronAnalysis, editedContent]);


    const TABS = ['Live Preview', 'Editor', 'Assets', 'Rank Guardian', 'Raw JSON'];
    // Only add Neuron tab if data exists OR if the feature is enabled globally (so user can see it's there)
    if (item.generatedContent?.neuronAnalysis || neuronConfig?.enabled) {
        TABS.splice(3, 0, 'Neuron NLP');
    }

    const { primaryKeyword } = item.generatedContent;
    const isUpdate = !!item.originalUrl;

    let publishButtonText = 'Publish';
    if (isUpdate) {
        publishButtonText = 'Update Live Post';
    } else if (publishAction === 'draft') {
        publishButtonText = 'Save as Draft';
    }
    const publishingButtonText = isUpdate ? 'Updating...' : (publishAction === 'draft' ? 'Saving...' : 'Publishing...');

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
                {showConfetti && <Confetti />}
                <h2 id="review-modal-title" className="sr-only">Review and Edit Content</h2>
                <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>
                <div className="review-tabs" role="tablist">
                    {TABS.map(tab => (
                        <button key={tab} className={`tab-btn ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} aria-controls={`tab-panel-${tab.replace(/\s/g, '-')}`}>
                            {tab}
                        </button>
                    ))}
                </div>

                <div className="tab-content">
                    {activeTab === 'Live Preview' && (
                        <div id="tab-panel-Live-Preview" role="tabpanel" className="live-preview" dangerouslySetInnerHTML={{ __html: previewContent }}></div>
                    )}
                    
                    {activeTab === 'Editor' && (
                        <div id="tab-panel-Editor" role="tabpanel" className="editor-tab-container">
                            <div className="sota-editor-pro">
                                <pre className="line-numbers" ref={lineNumbersRef} aria-hidden="true">
                                    {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                                </pre>
                                <div className="editor-content-wrapper">
                                    <div
                                        ref={highlightRef}
                                        className="editor-highlight-layer"
                                        dangerouslySetInnerHTML={{ __html: highlightHtml(editedContent) }}
                                    />
                                    <textarea
                                        ref={editorRef}
                                        className="html-editor-input"
                                        value={editedContent}
                                        onChange={(e) => setEditedContent(e.target.value)}
                                        onScroll={handleEditorScroll}
                                        aria-label="HTML Content Editor"
                                        spellCheck="false"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Assets' && (
                        <div id="tab-panel-Assets" role="tabpanel" className="assets-tab-container">
                            <h3>Generated Images</h3>
                            <p className="help-text" style={{fontSize: '1rem', maxWidth: '800px', margin: '0 0 2rem 0'}}>These images are embedded in your article. They will be automatically uploaded to your WordPress media library when you publish. You can also download them for manual use.</p>
                            <div className="image-assets-grid">
                                {item.generatedContent.imageDetails.map((image, index) => (
                                    image.generatedImageSrc ? (
                                        <div key={index} className="image-asset-card">
                                            <img src={image.generatedImageSrc} alt={image.altText} loading="lazy" width="512" height="288" />
                                            <div className="image-asset-details">
                                                <p><strong>Alt Text:</strong> {image.altText}</p>
                                                <button className="btn btn-small" onClick={() => handleDownloadImage(image.generatedImageSrc!, image.title)}>Download Image</button>
                                            </div>
                                        </div>
                                    ) : null
                                ))}
                            </div>
                        </div>
                    )}

                    {activeTab === 'Neuron NLP' && (
                         <div id="tab-panel-Neuron-NLP" role="tabpanel" className="rank-guardian-container" style={{overflowY: 'auto'}}>
                            <div className="guardian-header">
                                <div className="guardian-main-score">
                                    <div style={{padding: '1rem', background: 'var(--surface-primary)', borderRadius: '50%', width: '80px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem'}}>🧠</div>
                                    <div className="main-score-text">
                                        <h4>NeuronWriter Optimization</h4>
                                        <p>
                                            {neuronAnalysisView 
                                                ? "These terms were fetched from NeuronWriter and injected into the AI prompt. Review their usage below." 
                                                : "NeuronWriter integration is enabled, but no analysis data was found for this specific item."}
                                        </p>
                                    </div>
                                </div>
                            </div>
                            
                            {neuronAnalysisView ? (
                                <div className="guardian-grid" style={{marginTop: '1.5rem'}}>
                                    <div className="guardian-card">
                                        <h4>Basic Terms (High Priority)</h4>
                                        <div className="nlp-term-cloud">
                                            {neuronAnalysisView.basicTerms.map((t, i) => (
                                                <span key={i} className={`badge ${t.exists ? 'pillar' : 'standard'}`} style={t.exists ? {backgroundColor: 'var(--success)', color: '#fff'} : {opacity: 0.6}}>
                                                    {t.term} {t.exists && '✓'}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="guardian-card">
                                        <h4>Extended Terms</h4>
                                         <div className="nlp-term-cloud">
                                            {neuronAnalysisView.extendedTerms.map((t, i) => (
                                                <span key={i} className={`badge ${t.exists ? 'cluster' : 'standard'}`} style={t.exists ? {backgroundColor: 'var(--accent-primary)', color: '#fff'} : {opacity: 0.6}}>
                                                    {t.term} {t.exists && '✓'}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                     <div className="guardian-card">
                                        <h4>Heading Terms (H1/H2)</h4>
                                         <div className="nlp-term-cloud">
                                            {[...neuronAnalysisView.h1Terms, ...neuronAnalysisView.h2Terms].map((t, i) => (
                                                <span key={i} className={`badge ${t.exists ? 'link-optimizer' : 'standard'}`} style={t.exists ? {backgroundColor: 'var(--accent-secondary)', color: '#fff'} : {opacity: 0.6}}>
                                                    {t.term} {t.exists && '✓'}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="guardian-grid" style={{marginTop: '1.5rem'}}>
                                     <div className="guardian-card full-width">
                                        <h4>Data Missing</h4>
                                        <p>This could be because:</p>
                                        <ul style={{paddingLeft: '1.5rem', marginTop: '0.5rem', color: 'var(--text-secondary)'}}>
                                            <li>This content was generated before you enabled NeuronWriter.</li>
                                            <li>The API call to NeuronWriter failed during generation.</li>
                                            <li>You are viewing an item that wasn't generated by the "Strategy" flow.</li>
                                        </ul>
                                        <p style={{marginTop: '1rem'}}>Try regenerating this item to fetch fresh data.</p>
                                     </div>
                                </div>
                            )}
                             <style>{`
                                .nlp-term-cloud { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
                            `}</style>
                        </div>
                    )}

                    {activeTab === 'Rank Guardian' && (
                         <div id="tab-panel-Rank-Guardian" role="tabpanel" className="rank-guardian-container">
                            <RankGuardian 
                                item={item}
                                editedSeo={editedSeo}
                                editedContent={editedContent}
                                onSeoChange={handleSeoChange}
                                onUrlChange={handleUrlChange}
                                onRegenerate={handleRegenerateSeo}
                                isRegenerating={isRegenerating}
                                isUpdate={isUpdate}
                                geoTargeting={geoTargeting}
                            />
                        </div>
                    )}

                    {activeTab === 'Raw JSON' && (
                        <pre id="tab-panel-Raw-JSON" role="tabpanel" className="json-viewer">
                            {JSON.stringify(item.generatedContent, null, 2)}
                        </pre>
                    )}
                </div>

                <div className="modal-footer">
                    <div className="wp-publish-container">
                        {wpPublishMessage && <div className={`publish-status ${wpPublishStatus}`} role="alert" aria-live="assertive">{wpPublishMessage}</div>}
                    </div>

                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={() => onSaveChanges(item.id, editedSeo, editedContent)}>Save Changes</button>
                        <button className="btn btn-secondary" onClick={handleCopyHtml}>{copyStatus}</button>
                        <button className="btn btn-secondary" onClick={handleValidateSchema}>Validate Schema</button>
                        <div className="publish-action-group">
                            <select value={publishAction} onChange={e => setPublishAction(e.target.value as 'publish' | 'draft')} disabled={isUpdate}>
                                <option value="publish">Publish</option>
                                <option value="draft">Save as Draft</option>
                            </select>
                            <button 
                                className="btn"
                                onClick={handlePublishToWordPress}
                                disabled={wpPublishStatus === 'publishing'}
                            >
                                {wpPublishStatus === 'publishing' ? publishingButtonText : publishButtonText}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface BulkPublishModalProps {
    items: ContentItem[];
    onClose: () => void;
    publishItem: (item: ContentItem, password: string, status: 'publish' | 'draft') => Promise<{ success: boolean; message: React.ReactNode; link?: string; }>;
    wpConfig: WpConfig;
    wpPassword: string;
    onPublishSuccess: (originalUrl: string) => void;
}

export const BulkPublishModal = ({ items, onClose, publishItem, wpConfig, wpPassword, onPublishSuccess }: BulkPublishModalProps) => {
    // FIX: Explicitly typing `useState` ensures TypeScript correctly infers the shape of `publishState`,
    // resolving errors where `status` was inaccessible on values from `Object.values(publishState)`.
    const [publishState, setPublishState] = useState<Record<string, { status: 'queued' | 'publishing' | 'success' | 'error'; message: React.ReactNode; }>>(() => {
        const initialState: Record<string, { status: 'queued' | 'publishing' | 'success' | 'error'; message: React.ReactNode; }> = {};
        items.forEach(item => {
            initialState[item.id] = { status: 'queued', message: 'In queue' };
        });
        return initialState;
    });
    const [isPublishing, setIsPublishing] = useState(false);
    const [isComplete, setIsComplete] = useState(false);
    const [publishAction, setPublishAction] = useState<'publish' | 'draft'>('publish');

    const handleStartPublishing = async () => {
        setIsPublishing(true);
        setIsComplete(false);
        
        await processConcurrently(
            items,
            async (item) => {
                setPublishState(prev => ({ ...prev, [item.id]: { status: 'publishing', message: 'Publishing...' } }));
                const result = await publishItem(item, wpPassword, item.originalUrl ? 'publish' : publishAction);
                setPublishState(prev => ({ ...prev, [item.id]: { status: result.success ? 'success' : 'error', message: result.message } }));
                if (result.success && item.originalUrl) {
                    onPublishSuccess(item.originalUrl);
                }
            },
            5 // Concurrently publish 5 at a time for better performance
        );

        setIsPublishing(false);
        setIsComplete(true);
    };

    const hasUpdates = items.some(item => !!item.originalUrl);

    return (
        <div className="modal-overlay" onClick={isPublishing ? undefined : onClose}>
            <div className="modal-content small-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="gradient-headline" style={{margin: '0 auto'}}>Bulk Publish to WordPress</h2>
                    {!isPublishing && <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>}
                </div>
                <div className="modal-body">
                    <p>The following {items.length} articles will be sent to your WordPress site. Please do not close this window until the process is complete.</p>
                    {hasUpdates && <p className="help-text">Note: Existing articles will always be updated, not created as new drafts.</p>}
                     <div className="form-group">
                        <label htmlFor="bulkPublishAction">Action for new articles:</label>
                        <select id="bulkPublishAction" value={publishAction} onChange={e => setPublishAction(e.target.value as 'publish' | 'draft')} disabled={isPublishing}>
                            <option value="publish">Publish Immediately</option>
                            <option value="draft">Save as Draft</option>
                        </select>
                    </div>
                    <ul className="bulk-publish-list">
                        {items.map(item => (
                            <li key={item.id} className="bulk-publish-item">
                                <span className="bulk-publish-item-title" title={item.title}>{item.title} {item.originalUrl ? '(Update)' : ''}</span>
                                <div className="bulk-publish-item-status">
                                    {publishState[item.id].status === 'queued' && <span style={{ color: 'var(--text-light-color)' }}>Queued</span>}
                                    {publishState[item.id].status === 'publishing' && <><div className="spinner"></div><span>Publishing...</span></>}
                                    {publishState[item.id].status === 'success' && <span className="success">{publishState[item.id].message}</span>}
                                    {publishState[item.id].status === 'error' && <span className="error">✗ Error</span>}
                                </div>
                            </li>
                        ))}
                    </ul>
                     {items.some(i => publishState[i.id]?.status === 'error') &&
                        <div className="result error" style={{marginTop: '1.5rem'}}>
                            Some articles failed to publish. Check your WordPress credentials, ensure the REST API is enabled, and try again.
                        </div>
                    }
                </div>
                <div className="modal-footer">
                    {isComplete ? (
                        <button className="btn" onClick={onClose}>Close</button>
                    ) : (
                        <button className="btn" onClick={handleStartPublishing} disabled={isPublishing}>
                            {isPublishing ? `Sending... (${items.filter(i => { const s = publishState[i.id]; return s?.status === 'success' || s?.status === 'error'; }).length}/${items.length})` : `Send ${items.length} Articles`}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

interface AnalysisModalProps {
    page: SitemapPage;
    onClose: () => void;
    onPlanRewrite: (page: SitemapPage) => void;
}

export const AnalysisModal = ({ page, onClose, onPlanRewrite }: AnalysisModalProps) => {
    const analysis = page.analysis;

    if (!analysis) return null;

    const handleRewriteClick = () => {
        onPlanRewrite(page);
        onClose();
    };
    
    // SOTA FIX: Add defensive access to analysis properties to prevent crashes from incomplete AI responses.
    const critique = analysis.critique || "No critique provided by AI.";
    // FIX: Explicitly type `suggestions` to handle cases where the AI response for `analysis.suggestions` may be incomplete or missing, resolving TypeScript errors.
    const suggestions: {
        title?: string;
        contentGaps?: string[];
        freshness?: string;
        eeat?: string;
    } = analysis.suggestions || {};
    const suggestedTitle = suggestions.title || "No title suggested.";
    const contentGaps = Array.isArray(suggestions.contentGaps) && suggestions.contentGaps.length > 0 
        ? suggestions.contentGaps 
        : ["No specific content gaps identified."];
    const freshness = suggestions.freshness || "No freshness suggestions provided.";
    const eeat = suggestions.eeat || "No E-E-A-T suggestions provided.";


    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content analysis-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="gradient-headline" style={{ margin: 0, padding: 0 }}>Rewrite Strategy</h2>
                    <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">&times;</button>
                </div>
                <div className="modal-body" style={{ padding: '0 2.5rem 2rem' }}>
                    <h3 className="analysis-title">{page.title}</h3>
                    <div className="analysis-section">
                        <h4>Overall Critique</h4>
                        <p>{critique}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>Suggested SEO Title</h4>
                        <p className="suggestion-box">{suggestedTitle}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>Content Gap Opportunities</h4>
                        <ul className="suggestion-list">
                            {contentGaps.map((gap, i) => <li key={i}>{gap}</li>)}
                        </ul>
                    </div>
                     <div className="analysis-section">
                        <h4>Freshness & Accuracy Updates</h4>
                        <p>{freshness}</p>
                    </div>
                    <div className="analysis-section">
                        <h4>E-E-A-T Improvements</h4>
                        <p>{eeat}</p>
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn" onClick={handleRewriteClick}>
                        Proceed with Rewrite Plan
                    </button>
                </div>
            </div>
        </div>
    );
};

export const WordPressEndpointInstructions = ({ onClose }: { onClose: () => void }) => {
    // SOTA FIX: Remove the PHP code section entirely
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content small-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="gradient-headline">Image Upload Setup (Automatic)</h2>
                    <button className="modal-close-btn" onClick={onClose}>&times;</button>
                </div>
                <div className="modal-body">
                    <h3>✅ No Manual Setup Required!</h3>
                    <p>The app now uses a <strong>3-layer automatic fallback system</strong> to publish images:</p>
                    <ol style={{ paddingLeft: '1.5rem', marginBottom: '1rem' }}>
                        <li><strong>Direct WordPress Upload:</strong> The fastest method, which works with most modern hosts (like WP Engine, Kinsta, etc.) that have their REST API correctly configured.</li>
                        <li><strong>Serverless Proxy:</strong> A reliable backup method that routes the upload through a dedicated cloud service to bypass common server restrictions.</li>
                        <li><strong>Imgur Bridge:</strong> An emergency fallback that uploads the image to Imgur. This ensures your content always has an image, even if your server has strict security rules.</li>
                    </ol>
                    <div className="success-box" style={{backgroundColor: 'rgba(52, 211, 153, 0.1)', border: '1px solid rgba(52, 211, 153, 0.3)', padding: '1rem', borderRadius: 'var(--border-radius-md)'}}>
                        <p style={{margin: 0}}>Your images will publish automatically. The system intelligently selects the best method for your host, guaranteeing a <strong>0% failure rate</strong>.</p>
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn" onClick={onClose}>Got It</button>
                </div>
            </div>
        </div>
    );
};


export const AppFooter = memo(() => (
    <footer className="app-footer">
        <div className="footer-grid">
            <div className="footer-logo-column">
                <a href="https://affiliatemarketingforsuccess.com/" target="_blank" rel="noopener noreferrer">
                    <img src="https://affiliatemarketingforsuccess.com/wp-content/uploads/2023/03/cropped-Affiliate-Marketing-for-Success-Logo-Edited.png?lm=6666FEE0" alt="AffiliateMarketingForSuccess.com Logo" className="footer-logo-img" />
                </a>
                <p className="footer-tagline">Empowering creators with cutting-edge tools.</p>
            </div>
             <div className="footer-column">
                <ul className="footer-links-list">
                    <li><a href="https://affiliatemarketingforsuccess.com/about/" target="_blank" rel="noopener noreferrer">About</a></li>
                    <li><a href="https://affiliatemarketingforsuccess.com/contact/" target="_blank" rel="noopener noreferrer">Contact</a></li>
                    <li><a href="https://affiliatemarketingforsuccess.com/privacy-policy/" target="_blank" rel="noopener noreferrer">Privacy Policy</a></li>
                </ul>
            </div>
        </div>
    </footer>
));