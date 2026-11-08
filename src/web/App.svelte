<script lang="ts">
	import { onMount, tick } from "svelte";
	import BotEditor from "./BotEditor.svelte";
	import AskLog from "./AskLog.svelte";
	import ExposureEditor from "./ExposureEditor.svelte";
	import { actOnCard, devMember, enablePush, pushEnabled, pushSupported, setAppBadge, fetchBots, fetchMe, followThread, retryThread, sendMessage, setDevMember, type BotDefinition, type BotSummary, type Me, type Card, type ChatMessage, type ThreadView } from "./api.ts";

	let me = $state<Me | undefined>();
	let refused = $state(false);
	let view = $state<ThreadView>({ messages: [], busy: false });
	/**
	 * Messages with each Card placed after the last message written before it was posted, so a reply to a Card
	 * comes after the Card. Messages without a time (old threads) keep their order, and Cards go last.
	 */
	const timeline = $derived.by(() => {
		const items: ({ message: ChatMessage; card?: undefined } | { card: Card; message?: undefined })[] = view.messages.map((message) => ({ message }));
		for (const card of [...(view.cards ?? [])].sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))) {
			const t = Date.parse(card.createdAt ?? "");
			let at = items.length;
			if (!Number.isNaN(t)) {
				at = 0;
				items.forEach((item, i) => {
					if (item.message?.at !== undefined && item.message.at <= t) at = i + 1;
				});
				if (!items.some((item) => item.message?.at !== undefined)) at = items.length;
			}
			items.splice(at, 0, { card });
		}
		return items;
	});
	let bots = $state<BotSummary[]>([]);
	let botsFailed = $state(false);
	let botId = $state<string | undefined>();
	let online = $state(true);
	let text = $state("");
	let sending = $state(false);
	/** Why the last message could not be sent, such as the daily spend limit. */
	let sendError = $state<string | undefined>();
	/** What the form is doing: nothing, creating a Bot, or editing the current one. */
	let editing = $state<"create" | "edit" | "exposure" | "asks" | undefined>();
	/** Why the last tap on a Card was refused. */
	let cardError = $state<string | undefined>();
	let scroller: HTMLElement | undefined = $state();
	/** Whether this device gets push, and why turning it on failed. */
	let pushOn = $state(true);
	let pushError = $state<string | undefined>();
	const waitingTotal = $derived(bots.reduce((sum, b) => sum + (b.waiting ?? 0), 0));

	const bot = $derived(bots.find((b) => b.id === botId));

	async function load() {
		me = await fetchMe();
		refused = me === undefined;
		if (refused) return;
		const found = await fetchBots();
		botsFailed = found === undefined;
		bots = found ?? [];
		botId = bots[0]?.id;
	}

	async function saved(saved: BotDefinition) {
		editing = undefined;
		const found = await fetchBots();
		if (found !== undefined) bots = found;
		botId = saved.id;
	}

	// Badges come from /api/bots. A Card made or settled shows up through the open thread's stream (a changed `cards`), and a
	// slow poll catches Cards made in other threads, so the count stays close without a second live connection.
	async function refreshBadges() {
		const found = await fetchBots();
		if (found !== undefined) bots = found;
	}

	onMount(() => {
		load();
		pushEnabled().then((on) => (pushOn = on || !pushSupported()));
		const timer = setInterval(refreshBadges, 20_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		setAppBadge(waitingTotal);
	});

	// The open thread's Cards changed (one made or tapped), so its count and the others may have too.
	$effect(() => {
		JSON.stringify((view.cards ?? []).map((c) => [c.id, c.status]));
		if (me) refreshBadges();
	});

	async function turnOnPush() {
		pushError = await enablePush();
		if (pushError === undefined) pushOn = true;
	}

	// Switching Bots follows that Bot's thread; the server keeps each one, so nothing is lost by leaving.
	$effect(() => {
		const id = botId;
		if (id === undefined) return;
		view = { messages: [], busy: false };
		online = true;
		text = "";
		sendError = undefined;
		cardError = undefined;
		return followThread(
			id,
			(v) => (view = v),
			(o) => (online = o),
		);
	});

	$effect(() => {
		view.messages.length;
		view.draft;
		tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const message = text.trim();
		if (!message || sending) return;
		sending = true;
		if (botId !== undefined) {
			sendError = await sendMessage(botId, message);
			if (sendError === undefined) text = "";
		}
		sending = false;
	}

	async function tapCard(cardId: string, action: Parameters<typeof actOnCard>[1]) {
		cardError = await actOnCard(cardId, action);
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			(event.currentTarget as HTMLElement).closest("form")?.requestSubmit();
		}
	}

	function pickDev(id: string) {
		setDevMember(id);
		location.reload();
	}
</script>

<div class="mx-auto flex h-full max-w-2xl flex-col bg-white shadow-sm md:my-0 md:border-x md:border-gray-200">
	<header class="flex items-center justify-between border-b border-gray-200 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
		<div>
			<h1 class="text-base font-semibold">
				{bot?.name ?? "Hamkey"}
				{#if bot?.shared}<span class="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 align-middle text-xs font-medium text-emerald-800">Shared</span>{/if}
			</h1>
			{#if me && bot}<p class="text-xs text-gray-500">
					{bot.shared ? "Shared thread: both of you write here" : bot.kind === "common" ? `Private to ${me.member.name}, one Bot for both` : `Private to ${me.member.name}`}
				</p>{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if waitingTotal > 0}<span class="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white" role="status">{waitingTotal} waiting</span>{/if}
			{#if !online}<span class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Reconnecting…</span>{/if}
			{#if !editing}
				<button type="button" onclick={() => (editing = "exposure")} class="rounded border border-gray-300 px-2 py-1 text-xs">Sharing</button>
				<button type="button" onclick={() => (editing = "asks")} class="rounded border border-gray-300 px-2 py-1 text-xs">Ask log</button>
			{/if}
			{#if bot?.editable && !editing}
				<button type="button" onclick={() => (editing = "edit")} class="rounded border border-gray-300 px-2 py-1 text-xs">Edit</button>
			{/if}
			{#if import.meta.env.DEV}
				<select
					class="rounded border border-gray-300 text-xs"
					aria-label="Act as (development)"
					value={devMember() ?? ""}
					onchange={(e) => pickDev(e.currentTarget.value)}
				>
					<option value="">default</option>
					{#each me?.devMembers ?? [] as id}<option value={id}>{id}</option>{/each}
				</select>
			{/if}
		</div>
	</header>

	{#if refused}
		<main class="flex flex-1 items-center justify-center p-6 text-center text-gray-600">
			<p>Hamkey doesn't recognise this device. Open it from a Tailscale account that belongs to the household.</p>
		</main>
	{:else}
		<nav class="flex gap-2 overflow-x-auto border-b border-gray-200 px-3 py-2" aria-label="Bots">
			{#each bots as b (b.id)}
				<button
					type="button"
					onclick={() => (botId = b.id)}
					aria-current={b.id === botId ? "true" : undefined}
					class="shrink-0 rounded-full border px-3 py-1.5 text-sm {b.id === botId ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-700'}"
				>
					{b.name}
					<span class="text-xs opacity-70">{b.shared ? "shared" : b.kind}</span>
					{#if b.waiting}<span class="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white" aria-label="{b.waiting} waiting for you">{b.waiting}</span>{/if}
				</button>
			{/each}
			<button
				type="button"
				onclick={() => (editing = "create")}
				aria-label="Create a Bot"
				class="shrink-0 rounded-full border border-dashed border-gray-400 px-3 py-1.5 text-sm text-gray-700"
			>
				+ New
			</button>
		</nav>
		{#if !pushOn}
			<div class="flex items-center justify-between gap-2 bg-gray-50 px-4 py-2 text-sm">
				<span>Get a notification when a Bot needs you.</span>
				<button type="button" onclick={turnOnPush} class="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs">Enable notifications</button>
			</div>
			{#if pushError}<p class="px-4 py-1 text-center text-xs text-red-600" role="alert">{pushError}</p>{/if}
		{/if}
		{#if bot?.warning}
			<p class="bg-amber-50 px-4 py-2 text-center text-sm text-amber-800" role="status">{bot.warning}</p>
		{/if}
		{#if botsFailed}
			<p class="px-4 py-2 text-center text-sm text-red-600" role="alert">Could not load your Bots. Reload to try again.</p>
		{/if}
		{#if editing === "exposure"}
			<ExposureEditor ondone={() => (editing = undefined)} />
		{:else if editing === "asks"}
			<AskLog ondone={() => (editing = undefined)} />
		{:else if editing}
			{#key `${editing}:${botId}`}
				<BotEditor botId={editing === "edit" ? botId : undefined} onsaved={saved} oncancel={() => (editing = undefined)} />
			{/key}
		{:else}
		<main bind:this={scroller} class="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
			{#if bot?.web}
				<p class="rounded-lg bg-amber-50 px-3 py-2 text-center text-xs text-amber-900">Answers come from the web: check the sources before relying on them.</p>
			{/if}
			{#if view.messages.length === 0 && !view.draft}
				<p class="pt-8 text-center text-sm text-gray-400">Say hello to start the conversation.</p>
			{/if}
			{#each timeline as item (item.card ? `card:${item.card.id}` : item.message.id)}
				{#if item.message}
				{@const message = item.message}
				<!-- In a shared thread the other Member's messages are not mine, so the side follows the sender. -->
				{@const mine = message.role === "user" && (message.sender === undefined || message.sender.id === me?.member.id)}
				<div class="flex flex-col {mine ? 'items-end' : 'items-start'}">
					{#if bot?.shared && message.sender}<span class="mb-0.5 px-1 text-xs text-gray-500">{message.sender.name}</span>{/if}
					<p
						class="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed {mine
							? 'bg-gray-900 text-white'
							: message.role === 'user'
								? 'bg-emerald-100 text-gray-900'
								: 'bg-gray-100 text-gray-900'}"
					>
						{message.text}
					</p>
					{#if message.untrusted}<span class="mt-0.5 px-1 text-xs text-amber-700">from the web</span>{/if}
				</div>
				{:else if item.card}
				{@const card = item.card}
				<!-- Card text is plain text from the Bot, so it is interpolated, never inserted as HTML. -->
				<section class="max-w-[85%] space-y-2 rounded-2xl border border-gray-300 bg-white px-3.5 py-3 text-sm shadow-sm" aria-label="{card.type === 'approval' ? 'Approval' : card.type === 'question' ? 'Question' : 'Choice'} card">
					{#if card.type === "question"}
						<p class="text-xs font-medium text-gray-500">{card.bot.name} needs your answer</p>
						<p class="whitespace-pre-wrap font-medium">{card.fields.question}</p>
						<p class="text-xs text-gray-600">
							{card.status === "waiting" ? "Reply in this thread. The Bot could not find this out from the other Member's shared facts." : "Answered"}
						</p>
					{:else if card.type === "approval"}
						<p class="text-xs font-medium text-gray-500">{card.bot.name} suggests sharing</p>
						<p class="whitespace-pre-wrap">{card.fields.fact}</p>
						<p class="text-xs text-gray-600">Topic: <span class="font-medium">{card.fields.topicLabel}</span>. Until you approve, it stays private.</p>
						{#if card.status === "waiting"}
							<div class="flex gap-2">
								<button type="button" onclick={() => tapCard(card.id, { action: "approve" })} class="rounded-lg bg-gray-900 px-3 py-2 text-white">Approve</button>
								<button type="button" onclick={() => tapCard(card.id, { action: "reject" })} class="rounded-lg border border-gray-300 px-3 py-2">Reject</button>
							</div>
						{:else}
							<p class="text-xs font-medium {card.status === 'approved' ? 'text-emerald-700' : 'text-gray-500'}">
								{card.status === "approved" ? "Shared" : "Kept private"}
							</p>
						{/if}
					{:else}
						<p class="whitespace-pre-wrap font-medium">{card.fields.question}</p>
						<div class="flex flex-wrap gap-2">
							{#each card.fields.options ?? [] as option, i}
								{#if card.status === "waiting"}
									<button type="button" onclick={() => tapCard(card.id, { action: "choose", option: i })} class="rounded-lg border border-gray-300 px-3 py-2">{option}</button>
								{:else}
									<span class="rounded-lg border px-3 py-2 {card.choice === i ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-400'}">{option}</span>
								{/if}
							{/each}
						</div>
						{#if card.status === "chosen"}
							<p class="text-xs text-gray-500">{card.resolvedBy} chose: {card.fields.options?.[card.choice ?? -1]}</p>
						{/if}
					{/if}
				</section>
				{/if}
			{/each}
			{#if cardError}<p class="text-center text-sm text-red-600" role="alert">{cardError}</p>{/if}
			{#if view.stuck}
				<div class="flex flex-col items-center gap-2 text-sm text-red-600" role="alert">
					<p>This conversation stopped after repeated crashes.</p>
					<button type="button" onclick={async () => (sendError = botId === undefined ? undefined : await retryThread(botId))} class="rounded-lg border border-gray-300 px-3 py-2 text-gray-900">Retry</button>
				</div>
			{:else if view.busy}
				<div class="flex justify-start">
					<p class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-gray-100 px-3.5 py-2 text-sm leading-relaxed text-gray-900">
						{view.draft ?? "…"}
					</p>
				</div>
			{/if}
			{#if view.error}<p class="text-center text-sm text-red-600" role="alert">{view.error}</p>{/if}
			{#if sendError}<p class="text-center text-sm text-red-600" role="alert">{sendError}</p>{/if}
		</main>

		<form
			onsubmit={submit}
			class="flex items-end gap-2 border-t border-gray-200 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
		>
			<textarea
				bind:value={text}
				onkeydown={onKey}
				rows="1"
				placeholder={bot ? `Message ${bot.name}` : "Message"}
				aria-label="Message"
				class="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2.5 text-base focus:border-gray-900 focus:outline-none"
			></textarea>
			<button
				type="submit"
				disabled={sending || !text.trim()}
				class="h-11 rounded-xl bg-gray-900 px-4 text-sm font-medium text-white disabled:opacity-40"
			>
				Send
			</button>
		</form>
		{/if}
	{/if}
</div>
