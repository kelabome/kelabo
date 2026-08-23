import { Stack, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";

const S = dynamodb.AttributeType.STRING;
const N = dynamodb.AttributeType.NUMBER;

export class DynamoDbStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { cfg } = props;
    const names = cfg.tableNames;

    const table = (id, tableName, opts) =>
      new dynamodb.Table(this, id, {
        tableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.RETAIN,
        ...opts,
      });

    const kelabos = table("KelabosTable", names.kelabos, {
      partitionKey: { name: "PK", type: S },
      sortKey: { name: "SK", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
    });
    kelabos.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "tenantStatus", type: S },
      sortKey: { name: "startedAt", type: N },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Sparse on `inviteKey`, which only an INVITE# item ever carries (the same
    // trick status-index plays on tenantStatus, which only META carries) — so
    // this indexes exactly the rows that name who was invited, nothing else.
    // What it is for: a kelabo's tenantStatus names its HOST's tenant, never an
    // invitee's, so status-index alone can never surface a kelabo to someone
    // invited across a domain boundary — this is the other half of "who can
    // see this kelabo", queried by the invitee's own identity instead of by
    // tenant (docs 18 §2.8).
    kelabos.addGlobalSecondaryIndex({
      indexName: "invitee-index",
      partitionKey: { name: "inviteKey", type: S },
      sortKey: { name: "invitedAt", type: N },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const history = table("HistoryTable", names.history, {
      partitionKey: { name: "archiveId", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    history.addGlobalSecondaryIndex({
      indexName: "participant-index",
      partitionKey: { name: "participantIdentity", type: S },
      sortKey: { name: "endedAt", type: N },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const users = table("UsersTable", names.users, {
      partitionKey: { name: "PK", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // Everyone registered at one email domain, by address. This is what the
    // invitee autocomplete reads: the people who actually have accounts here,
    // not a separate list that could disagree with them. Anyone in a domain may
    // see the names and addresses of everyone else in that domain — the tenant
    // boundary is the privacy boundary, and it is the partition key, so a query
    // cannot cross it even by mistake.
    users.addGlobalSecondaryIndex({
      indexName: "tenant-index",
      partitionKey: { name: "tenantId", type: S },
      sortKey: { name: "email", type: S },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["displayName"],
    });

    const otp = table("OtpTable", names.otp, {
      partitionKey: { name: "PK", type: S },
      timeToLiveAttribute: "ttl",
    });

    const refresh = table("RefreshTable", names.refresh, {
      partitionKey: { name: "PK", type: S },
      timeToLiveAttribute: "ttl",
    });
    refresh.addGlobalSecondaryIndex({
      indexName: "identity-index",
      partitionKey: { name: "identityHash", type: S },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // The MCP table holds third-party OAuth access AND refresh tokens
    // (SK=TOKEN#<server>) plus dynamic client registrations (PK=MCP#client), so
    // it gets a customer-managed key rather than the AWS-owned default: we want
    // an auditable key policy and the ability to revoke access to the material
    // independently of table permissions.
    this.mcpKey = new kms.Key(this, "McpKey", {
      alias: `alias/${names.mcp}`,
      description: "Kelabo MCP server credentials (OAuth tokens, client registrations)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const mcp = table("McpTable", names.mcp, {
      partitionKey: { name: "PK", type: S },
      sortKey: { name: "SK", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.mcpKey,
    });

    // Contacts (docs 18 §4). One partition per owner, `PK = CONTACT#<owner>`,
    // holding two item kinds by SK prefix: `FAV#<peer>` (a private, one-way
    // favourite marker on a same-org colleague) and `PEER#<peer>` (one side of a
    // mirrored external link). No GSI: external links are mirrored, so a single
    // `Query PK = CONTACT#<me>` answers both "who I watch" and "who watches me".
    // A `ttl` attribute is declared for the decline-cleanup grace on external
    // rows; favourites never set it.
    const contacts = table("ContactsTable", names.contacts, {
      partitionKey: { name: "PK", type: S },
      sortKey: { name: "SK", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
    });

    // Journey (docs 20). One partition per journey, `PK = JOURNEY#<id>`,
    // holding META, a DESC# version chain, ACCESSOR# (private-journey
    // roster), and LINK# (kelabo membership) items by SK prefix. No `ttl` —
    // a journey never auto-expires; every removal in docs 20 is an explicit
    // write, unlike the orphaned-child trap TTL creates on `kelabos`.
    const journeys = table("JourneysTable", names.journeys, {
      partitionKey: { name: "PK", type: S },
      sortKey: { name: "SK", type: S },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // Sparse on `tenantStatus`, which only META carries — "journeys in my
    // tenant" (docs 20 §4.2), the same trick kelabos.status-index plays.
    journeys.addGlobalSecondaryIndex({
      indexName: "tenant-status-index",
      partitionKey: { name: "tenantStatus", type: S },
      sortKey: { name: "updatedAt", type: N },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Sparse on `accessorIdentity`, which only an ACCESSOR# item carries —
    // "private journeys I'm an accessor of", a structural copy of kelabos'
    // invitee-index.
    journeys.addGlobalSecondaryIndex({
      indexName: "accessor-index",
      partitionKey: { name: "accessorIdentity", type: S },
      sortKey: { name: "addedAt", type: N },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.tables = { kelabos, history, users, otp, refresh, mcp, contacts, journeys };

    this.archiveBucket = new s3.Bucket(this, "ArchiveBucket", {
      bucketName: cfg.archiveBucket.toLowerCase().replace(/[^a-z0-9.-]/g, "-"),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const [key, t] of Object.entries(this.tables)) {
      new CfnOutput(this, `TableName${key}`, { value: t.tableName });
    }
    new CfnOutput(this, "ArchiveBucketName", { value: this.archiveBucket.bucketName });
  }
}
