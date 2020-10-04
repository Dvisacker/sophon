import EventEmitter from 'events';
import {
  EthAddress,
  Location,
  Planet,
  PlanetMap,
  Player,
  PlayerMap,
  QueuedArrival,
  PlanetVoyageIdMap,
  LocationId,
  ExploredChunkData,
  VoyageContractData,
  PlanetLevel,
  Upgrade,
  ChunkFootprint,
  SpaceType,
} from '../_types/global/GlobalTypes';
import LocalStorageManager from './LocalStorageManager';
import { MIN_CHUNK_SIZE } from '../utils/constants';
import mimcHash from '../miner/mimc';
import ContractsAPI from './ContractsAPI';
import MinerManager, {
  HomePlanetMinerChunkStore,
  MinerManagerEvent,
} from './MinerManager';
import SnarkHelper from './SnarkArgsHelper';
import { WorldCoords } from '../utils/Coordinates';
import _ from 'lodash';

import { SpiralPattern, MiningPattern } from '../utils/MiningPatterns';
import AbstractGameManager from './AbstractGameManager';
import {
  ContractConstants,
  UnconfirmedTx,
  UnconfirmedMove,
  ContractsAPIEvent,
  UpgradeArgs,
  UnconfirmedUpgrade,
  EthTxType,
  SubmittedTx,
  UnconfirmedBuyHat,
  UnconfirmedInit,
} from '../_types/darkforest/api/ContractsAPITypes';
import perlin from '../miner/perlin';
import { PlanetHelper } from './PlanetHelper';
import {
  locationIdFromBigInt,
  locationIdToBigNumber,
  address,
  locationIdFromHexStr,
} from '../utils/CheckedTypeUtils';

export enum GameManagerEvent {
  PlanetUpdate = 'PlanetUpdate',
  DiscoveredNewChunk = 'DiscoveredNewChunk',
  InitializedPlayer = 'InitializedPlayer',
  InitializedPlayerError = 'InitializedPlayerError',
  Moved = 'Moved',
}
import TerminalEmitter, { TerminalTextStyle } from '../utils/TerminalEmitter';
import { getAllTwitters, verifyTwitterHandle } from './UtilityServerAPI';
import EthereumAccountManager from './EthereumAccountManager';
import { getRandomActionId } from '../utils/Utils';
import NotificationManager from '../utils/NotificationManager';
import {
  planetRandomInt
} from '../utils/ProcgenUtils';


class GameManager extends EventEmitter implements AbstractGameManager {
  private readonly account: EthAddress | null;
  private balance: number;
  private balanceInterval: number;
  private readonly players: PlayerMap;

  private readonly contractsAPI: ContractsAPI;
  private readonly localStorageManager: LocalStorageManager;
  private readonly snarkHelper: SnarkHelper;
  private readonly planetHelper: PlanetHelper;

  private readonly useMockHash: boolean;

  private minerManager?: MinerManager;
  private hashRate: number;

  private homeCoords: WorldCoords | null;
  private homeHash: LocationId | null;

  private readonly contractConstants: ContractConstants;

  private worldRadius: number;

  private get planetRarity(): number {
    return this.contractConstants.PLANET_RARITY;
  }

  private readonly endTimeSeconds: number = 1609372800;

  private explorerIPs: string[];
  private explorers: any[];
  lastChunkPerExplorer: Map<string, ChunkFootprint>;
  hashRatePerExplorer: Map<string, number>;

  private constructor(
    account: EthAddress | null,
    balance: number,
    players: PlayerMap,
    planets: PlanetMap,
    worldRadius: number,
    unprocessedArrivals: VoyageContractData,
    unprocessedPlanetArrivalIds: PlanetVoyageIdMap,
    contractsAPI: ContractsAPI,
    contractConstants: ContractConstants,
    localStorageManager: LocalStorageManager,
    snarkHelper: SnarkHelper,
    homeCoords: WorldCoords | null,
    useMockHash: boolean
  ) {
    super();

    this.explorerIPs = [
      'http://165.232.57.41',
    ];
    this.lastChunkPerExplorer = new Map();
    this.hashRatePerExplorer = new Map();

    this.account = account;
    this.balance = balance;
    this.players = players;
    this.worldRadius = worldRadius;

    this.contractConstants = contractConstants;
    this.homeCoords = homeCoords;

    this.planetHelper = new PlanetHelper(
      planets,
      localStorageManager,
      unprocessedArrivals,
      unprocessedPlanetArrivalIds,
      contractConstants,
      this.endTimeSeconds,
      this.getAccount()
    );
    this.contractsAPI = contractsAPI;
    this.localStorageManager = localStorageManager;
    this.snarkHelper = snarkHelper;
    this.useMockHash = useMockHash;

    this.balanceInterval = setInterval(() => {
      if (this.account) {
        EthereumAccountManager.getInstance()
          .getBalance(this.account)
          .then((balance) => {
            this.balance = balance;
          });
      }
    }, 5000);

    this.hashRate = 0;
  }

  public destroy(): void {
    // removes singletons of ContractsAPI, LocalStorageManager, MinerManager
    if (this.minerManager) {
      this.minerManager.removeAllListeners(
        MinerManagerEvent.DiscoveredNewChunk
      );
      this.minerManager.destroy();
    }
    this.contractsAPI.removeAllListeners(ContractsAPIEvent.PlayerInit);
    this.contractsAPI.removeAllListeners(ContractsAPIEvent.PlanetUpdate);
    this.contractsAPI.destroy();
    this.localStorageManager.destroy();
    this.snarkHelper.destroy();
    clearInterval(this.balanceInterval);
  }

  static async create(): Promise<GameManager> {
    // initialize dependencies according to a DAG

    // first we initialize the ContractsAPI and get the user's eth account, and load contract constants + state
    const contractsAPI = await ContractsAPI.create();
    const useMockHash = await contractsAPI.zkChecksDisabled();

    // then we initialize the local storage manager and SNARK helper
    const account = contractsAPI.account;
    const balance = await EthereumAccountManager.getInstance().getBalance(
      account
    );
    const localStorageManager = await LocalStorageManager.create(account);
    const homeCoords = await localStorageManager.getHomeCoords();
    const snarkHelper = SnarkHelper.create(useMockHash);

    // get data from the contract
    const contractConstants = await contractsAPI.getConstants();
    const players = await contractsAPI.getPlayers();
    const worldRadius = await contractsAPI.getWorldRadius();

    const arrivals: VoyageContractData = {};
    const planetVoyageIdMap: PlanetVoyageIdMap = {};
    const arrivalPromises: Promise<null>[] = [];
    const allArrivals = await contractsAPI.getAllArrivals();
    // fetch planets after allArrivals, since an arrival to a new planet might be sent
    // while we are fetching
    const planets = await contractsAPI.getPlanets();
    for (const planetId in planets) {
      let pid = locationIdFromHexStr(planetId);
      const randInt = planetRandomInt(pid);

      if (randInt() % 1024 === 0) {
        console.log("Clown town alert", pid)
      }
      if (planets.hasOwnProperty(planetId)) {
        planetVoyageIdMap[planetId] = [];
      }
    }


    for (const arrival of allArrivals) {
      planetVoyageIdMap[arrival.toPlanet].push(arrival.eventId);
      arrivals[arrival.eventId] = arrival;
    }
    await Promise.all(arrivalPromises);

    const gameManager = new GameManager(
      account,
      balance,
      players,
      planets,
      worldRadius,
      arrivals,
      planetVoyageIdMap,
      contractsAPI,
      contractConstants,
      localStorageManager,
      snarkHelper,
      homeCoords,
      useMockHash
    );

    // get twitter handles
    gameManager.refreshTwitters();

    // set up listeners: whenever ContractsAPI reports some game state update, do some logic
    gameManager.contractsAPI
      .on(ContractsAPIEvent.PlayerInit, (player: Player) => {
        gameManager.players[player.address] = player;
      })
      .on(ContractsAPIEvent.PlanetUpdate, async (planet: Planet) => {
        const arrivals = await contractsAPI.getArrivalsForPlanet(planet);
        gameManager.planetHelper.refreshPlanetAndArrivals(planet, arrivals);
        gameManager.emit(GameManagerEvent.PlanetUpdate);
      })
      .on(ContractsAPIEvent.TxInitialized, (unconfirmedTx: UnconfirmedTx) => {
        gameManager.planetHelper.onTxInit(unconfirmedTx);
      })
      .on(
        ContractsAPIEvent.TxInitFailed,
        (unconfirmedTx: UnconfirmedTx, e: Error) => {
          const terminalEmitter = TerminalEmitter.getInstance();
          terminalEmitter.println(
            `[TX ERROR]: ${e.message.slice(0, 10000)}`,
            TerminalTextStyle.Red,
            true
          );
          gameManager.planetHelper.clearUnconfirmedTx(unconfirmedTx);
        }
      )
      .on(ContractsAPIEvent.TxSubmitted, (unconfirmedTx: SubmittedTx) => {
        gameManager.localStorageManager.onEthTxSubmit(unconfirmedTx);
      })
      .on(ContractsAPIEvent.TxConfirmed, async (unconfirmedTx: SubmittedTx) => {
        gameManager.planetHelper.clearUnconfirmedTx(unconfirmedTx);
        gameManager.localStorageManager.onEthTxComplete(unconfirmedTx.txHash);
        if (gameManager.account) {
          gameManager.balance = await EthereumAccountManager.getInstance().getBalance(
            gameManager.account
          );
        }
      })
      .on(ContractsAPIEvent.RadiusUpdated, async () => {
        const newRadius = await gameManager.contractsAPI.getWorldRadius();
        gameManager.setRadius(newRadius);
      });

    const unconfirmedTxs = await localStorageManager.getUnconfirmedSubmittedEthTxs();
    for (const unconfirmedTx of unconfirmedTxs) {
      // recommits the tx to storage but whatever
      gameManager.contractsAPI.onTxSubmit(unconfirmedTx);
    }

    // we only want to initialize the mining manager if the player has already joined the game
    // if they haven't, we'll do this once the player has joined the game
    if (!!homeCoords && account in players) {
      gameManager.initMiningManager(homeCoords);
    }

    return gameManager;
  }

  public getAccount(): EthAddress | null {
    return this.account;
  }

  public getContractAddress(): EthAddress {
    return this.contractsAPI.getContractAddress();
  }

  public getTwitter(address: EthAddress | null): string | null {
    let myAddress;
    if (!address) myAddress = this.getAccount();
    else myAddress = address;

    if (!myAddress) {
      return null;
    }
    const twitter = this.players[myAddress]?.twitter;
    return twitter || null;
  }

  public getEndTimeSeconds(): number {
    return this.endTimeSeconds;
  }

  public getEnergyCurveAtPercent(planet: Planet, percent: number): number {
    return this.planetHelper.getEnergyCurveAtPercent(planet, percent);
  }

  public getSilverCurveAtPercent(
    planet: Planet,
    percent: number
  ): number | null {
    return this.planetHelper.getSilverCurveAtPercent(planet, percent);
  }

  public getUpgrade(branch: number, level: number): Upgrade {
    return this.contractConstants.upgrades[branch][level];
  }

  public getAllPlayers(): Player[] {
    return Object.values(this.players);
  }

  public getExploredChunks(): Iterable<ExploredChunkData> {
    return this.localStorageManager.allChunks();
  }

  public getWorldRadius(): number {
    return this.worldRadius;
  }

  public getWorldSilver(): number {
    return this.getAllOwnedPlanets().reduce(
      (totalSoFar: number, nextPlanet: Planet) =>
        totalSoFar + nextPlanet.silver,
      0
    );
  }

  public getUniverseTotalEnergy(): number {
    return this.getAllOwnedPlanets().reduce(
      (totalSoFar: number, nextPlanet: Planet) =>
        totalSoFar + nextPlanet.energy,
      0
    );
  }

  public getSilverOfPlayer(player: EthAddress): number {
    return this.getAllOwnedPlanets()
      .filter((planet) => planet.owner === player)
      .reduce(
        (totalSoFar: number, nextPlanet: Planet) =>
          totalSoFar + nextPlanet.silver,
        0
      );
  }

  public getEnergyOfPlayer(player: EthAddress): number {
    return this.getAllOwnedPlanets()
      .filter((planet) => planet.owner === player)
      .reduce(
        (totalSoFar: number, nextPlanet: Planet) =>
          totalSoFar + nextPlanet.energy,
        0
      );
  }

  private initMiningManager(_: WorldCoords): void {
    if (window.Primus) {
      this.explorers = this.explorerIPs.map((ip) => {
        const explorer = new window.Primus(ip);
        explorer.on('sync-map', (chunks) => {
          chunks.forEach((chunk) => this.addNewChunk(chunk));
        });
        explorer.on('new-chunk', (chunk) => {
          this.lastChunkPerExplorer.set(ip, chunk.chunkFootprint);
          this.addNewChunk(chunk);
          this.emit(GameManagerEvent.DiscoveredNewChunk, chunk);
        });
        explorer.on('hash-rate', (hashRate) => {
          this.hashRatePerExplorer.set(ip, hashRate);
        });
        explorer.emit('set-radius', this.worldRadius);
        return explorer;
      });
    }
  }

  setMiningPattern(pattern: MiningPattern): void {
    // TODO: Select box to control any explorer IP
    if (this.explorers) {
      this.explorers[0].emit('set-pattern', pattern.center);
    }
    if (this.minerManager) {
      this.minerManager.setMiningPattern(pattern);
    }
  }
  getMiningPattern(): MiningPattern | null {
    if (this.minerManager) return this.minerManager.getMiningPattern();
    else return null;
  }

  getCurrentlyExploringChunk(): ChunkFootprint | null {
    if (this.lastChunk) {
      return this.lastChunk;
    }
    if (this.minerManager) {
      return this.minerManager.getCurrentlyExploringChunk();
    }
    return null;
  }

  hasJoinedGame(): boolean {
    return (this.account as string) in this.players;
  }

  // can't just hash the coords and ask planetHelper since this needs to be fast
  // so we sort of use knownChunks as a cache
  getPlanetWithCoords(coords: WorldCoords): Planet | null {
    return this.planetHelper.getPlanetWithCoords(coords);
  }

  // gets a planet by ID. returns empty planet if planet is not in contract
  // planetID must be in the contract or in known chunks, else returns null
  getPlanetWithId(planetId: LocationId): Planet | null {
    return this.planetHelper.getPlanetWithId(planetId);
  }

  // fast query that doesn't update planet if stale
  // returns null if planet is neither in contract nor known chunks
  getPlanetLevel(planetId: LocationId): PlanetLevel | null {
    return this.planetHelper.getPlanetLevel(planetId);
  }

  // fast query that doesn't update planet if stale
  // returns null if planet is neither in contract nor known chunks
  getPlanetDetailLevel(planetId: LocationId): number | null {
    if (planetId === this.homeHash) {
      return Infinity;
    }
    return this.planetHelper.getPlanetDetailLevel(planetId);
  }

  getLocationOfPlanet(planetId: LocationId): Location | null {
    return this.planetHelper.getLocationOfPlanet(planetId);
  }

  getAllVoyages(): QueuedArrival[] {
    return this.planetHelper.getAllVoyages();
  }

  getAllOwnedPlanets(): Planet[] {
    return this.planetHelper.getAllOwnedPlanets();
  }

  spaceTypeFromPerlin(perlin: number): SpaceType {
    return this.planetHelper.spaceTypeFromPerlin(perlin);
  }

  getHashesPerSec(): Map<string, number> {
    return this.hashRatePerExplorer;
  }

  async getSignedTwitter(twitter: string): Promise<string> {
    return EthereumAccountManager.getInstance().signMessage(twitter);
  }

  getPrivateKey(): string {
    return EthereumAccountManager.getInstance().getPrivateKey();
  }

  getMyBalance(): number {
    if (!this.account) return 0;
    return this.balance;
  }

  async notifyIfBalanceEmpty(): Promise<void> {
    const balance = await this.getMyBalance();
    const notifManager = NotificationManager.getInstance();

    if (balance < 0.0015) {
      notifManager.balanceEmpty();
    }
  }

  getUnconfirmedMoves(): UnconfirmedMove[] {
    return this.planetHelper.getUnconfirmedMoves();
  }

  getUnconfirmedUpgrades(): UnconfirmedUpgrade[] {
    return this.planetHelper.getUnconfirmedUpgrades();
  }

  // can return undefined
  getHomeCoords(): WorldCoords | null {
    if (!this.homeCoords) return null;
    return {
      x: this.homeCoords.x,
      y: this.homeCoords.y,
    };
  }

  getHomeHash(): LocationId | null {
    return this.homeHash;
  }

  hasMinedChunk(chunkLocation: ChunkFootprint): boolean {
    return this.localStorageManager.hasMinedChunk(chunkLocation);
  }

  getPerlinThresholds(): [number, number] {
    return [
      this.contractConstants.PERLIN_THRESHOLD_1,
      this.contractConstants.PERLIN_THRESHOLD_2,
    ];
  }

  startExplore(): void {
    if (this.minerManager) {
      this.minerManager.startExplore();
    }
  }

  stopExplore(): void {
    if (this.minerManager) {
      this.hashRate = 0;
      this.minerManager.stopExplore();
    }
  }

  private setRadius(worldRadius: number) {
    this.worldRadius = worldRadius;

    this.explorers.forEach((explorer) => {
      explorer.emit('set-radius', worldRadius);
    });

    if (this.minerManager) {
      this.minerManager.setRadius(this.worldRadius);
    }
  }

  private async refreshTwitters(): Promise<void> {
    // get twitter handles
    const addressTwitters = await getAllTwitters();
    for (const key of Object.keys(addressTwitters)) {
      const addr = address(key);
      if (this.players[addr]) {
        this.players[addr].twitter = addressTwitters[addr];
      }
    }
  }

  async verifyTwitter(twitter: string): Promise<boolean> {
    if (!this.account) return Promise.resolve(false);
    const success = await verifyTwitterHandle(twitter, this.account);
    await this.refreshTwitters();
    return success;
  }

  joinGame(): GameManager {
    if (Date.now() / 1000 > this.endTimeSeconds) {
      const terminalEmitter = TerminalEmitter.getInstance();
      terminalEmitter.println('[ERROR] Game has ended.');
      return this;
    }
    let actionId: string;
    let homeCoords: WorldCoords;
    let unconfirmedTx: UnconfirmedInit;
    this.getRandomHomePlanetCoords()
      .then(async (loc) => {
        const {
          coords: { x, y },
          hash: h,
        } = loc;
        console.log(x, y);
        homeCoords = { x, y };
        await this.localStorageManager.setHomeCoords(homeCoords); // set this before getting the call result, in case user exits before tx confirmed
        this.homeCoords = homeCoords;
        this.homeHash = h;
        actionId = getRandomActionId();
        unconfirmedTx = {
          actionId,
          type: EthTxType.INIT,
          locationId: h,
        };
        this.contractsAPI.onTxInit(unconfirmedTx as UnconfirmedTx);
        return this.snarkHelper.getInitArgs(
          x,
          y,
          perlin({ x, y }),
          this.worldRadius
        );
      })
      .then((callArgs) => {
        return this.contractsAPI.initializePlayer(callArgs, actionId);
      })
      .then(async () => {
        this.initMiningManager(homeCoords);
        this.emit(GameManagerEvent.InitializedPlayer);
      })
      .catch((err) => {
        const notifManager = NotificationManager.getInstance();
        notifManager.unsubmittedTxFail(unconfirmedTx, err);
        this.contractsAPI.emit(
          ContractsAPIEvent.TxInitFailed,
          unconfirmedTx,
          err
        );
        this.emit(GameManagerEvent.InitializedPlayerError, err);
      });

    return this;
  }

  async addAccount(coords: WorldCoords): Promise<boolean> {
    const homePlanetId = locationIdFromBigInt(mimcHash(coords.x, coords.y));
    const planet = this.getPlanetWithId(homePlanetId);
    if (!planet || planet.owner !== this.account) {
      return Promise.resolve(false);
    }
    await this.localStorageManager.setHomeCoords(coords);
    this.initMiningManager(coords);
    this.homeCoords = coords;
    return true;
  }

  private async getRandomHomePlanetCoords(): Promise<Location> {
    const terminalEmitter = TerminalEmitter.getInstance();

    // We need to populate this...
    const planetLoc: Location = {
      coords: {
        x: 0,
        y: 0,
      },
      hash: locationIdFromHexStr(''),
      perlin: 0,
    };

    return Promise.resolve(planetLoc);
  }

  move(
    from: LocationId,
    to: LocationId,
    forces: number,
    silver: number
  ): GameManager {
    this.notifyIfBalanceEmpty();

    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-fromPlanet`,
      from
    );
    localStorage.setItem(`${this.getAccount()?.toLowerCase()}-toPlanet`, to);

    if (Date.now() / 1000 > this.endTimeSeconds) {
      const terminalEmitter = TerminalEmitter.getInstance();
      terminalEmitter.println('[ERROR] Game has ended.');
      return this;
    }

    const oldLocation = this.planetHelper.getLocationOfPlanet(from);
    const newLocation = this.planetHelper.getLocationOfPlanet(to);
    if (!oldLocation) {
      console.error('tried to move from planet that does not exist');
      return this;
    }
    if (!newLocation) {
      console.error('tried to move from planet that does not exist');
      return this;
    }

    const oldX = oldLocation.coords.x;
    const oldY = oldLocation.coords.y;
    const newX = newLocation.coords.x;
    const newY = newLocation.coords.y;
    const xDiff = newX - oldX;
    const yDiff = newY - oldY;

    const distMax = Math.ceil(Math.sqrt(xDiff ** 2 + yDiff ** 2));

    const shipsMoved = forces;
    const silverMoved = silver;

    if (newX ** 2 + newY ** 2 >= this.worldRadius ** 2) {
      throw new Error('attempted to move out of bounds');
    }

    const oldPlanet = this.planetHelper.getPlanetWithLocation(oldLocation);

    if (!this.account || !oldPlanet || oldPlanet.owner !== this.account) {
      throw new Error('attempted to move from a planet not owned by player');
    }
    const actionId = getRandomActionId();
    const unconfirmedTx = {
      actionId,
      type: EthTxType.MOVE,
      from: oldLocation.hash,
      to: newLocation.hash,
      forces: shipsMoved,
      silver: silverMoved,
    };
    this.contractsAPI.onTxInit(unconfirmedTx as UnconfirmedTx);

    this.snarkHelper
      .getMoveArgs(
        oldX,
        oldY,
        newX,
        newY,
        perlin({ x: newX, y: newY }),
        this.worldRadius,
        distMax
      )
      .then((callArgs) => {
        return this.contractsAPI.move(
          callArgs,
          shipsMoved,
          silverMoved,
          actionId
        );
      })
      .then(() => {
        //no-op, delete?
        this.emit(GameManagerEvent.Moved);
      })
      .catch((err) => {
        const notifManager = NotificationManager.getInstance();
        notifManager.unsubmittedTxFail(unconfirmedTx, err);
        this.contractsAPI.emit(
          ContractsAPIEvent.TxInitFailed,
          unconfirmedTx,
          err
        );
      });
    return this;
  }

  upgrade(planetId: LocationId, branch: number): GameManager {
    this.notifyIfBalanceEmpty();

    // this is shitty
    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-upPlanet`,
      planetId
    );
    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-branch`,
      branch.toString()
    );

    if (Date.now() / 1000 > this.endTimeSeconds) {
      const terminalEmitter = TerminalEmitter.getInstance();
      terminalEmitter.println('[ERROR] Game has ended.');
      return this;
    }

    const upgradeArgs: UpgradeArgs = [
      locationIdToBigNumber(planetId).toString(),
      branch.toString(),
    ];
    const actionId = getRandomActionId();
    const unconfirmedTx = {
      actionId,
      type: EthTxType.UPGRADE,
      locationId: planetId,
      upgradeBranch: branch,
    };
    this.contractsAPI.onTxInit(unconfirmedTx as UnconfirmedUpgrade);

    try {
      this.contractsAPI.upgradePlanet(upgradeArgs, actionId);
    } catch (e) {
      const notifManager = NotificationManager.getInstance();
      notifManager.unsubmittedTxFail(unconfirmedTx, e);
      this.contractsAPI.emit(ContractsAPIEvent.TxInitFailed, unconfirmedTx, e);
    }
    return this;
  }

  buyHat(planetId: LocationId): GameManager {
    const terminalEmitter = TerminalEmitter.getInstance();
    this.notifyIfBalanceEmpty();

    const planetLoc = this.planetHelper.getLocationOfPlanet(planetId);
    if (!planetLoc) {
      console.error('planet not found');
      terminalEmitter.println('[TX ERROR] Planet not found');
      return this;
    }
    const planet = this.planetHelper.getPlanetWithLocation(planetLoc);
    if (!planet) {
      console.error('planet not found');
      terminalEmitter.println('[TX ERROR] Planet not found');
      return this;
    }

    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-hatPlanet`,
      planetId
    );
    localStorage.setItem(
      `${this.getAccount()?.toLowerCase()}-hatLevel`,
      (planet.hatLevel + 1).toString()
    );

    const actionId = getRandomActionId();
    const unconfirmedTx = {
      actionId,
      type: EthTxType.BUY_HAT,
      locationId: planetId,
    };
    this.contractsAPI.onTxInit(unconfirmedTx as UnconfirmedBuyHat);

    try {
      this.contractsAPI.buyHat(
        locationIdToBigNumber(planetId).toString(),
        planet.hatLevel,
        actionId
      );
    } catch (e) {
      const notifManager = NotificationManager.getInstance();
      notifManager.unsubmittedTxFail(unconfirmedTx, e);
      this.contractsAPI.emit(ContractsAPIEvent.TxInitFailed, unconfirmedTx, e);
    }
    return this;
  }

  addNewChunk(chunk: ExploredChunkData): GameManager {
    this.localStorageManager.updateChunk(chunk, false);
    for (const planetLocation of chunk.planetLocations) {
      this.planetHelper.addPlanetLocation(planetLocation);
    }
    return this;
  }
}

export default GameManager;
