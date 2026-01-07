/**
 * @public
 * @enum
 */
export declare const FilterNameStringType: {
    readonly all: "all";
    readonly description: "description";
    readonly name: "name";
    readonly owning_service: "owning-service";
    readonly primary_region: "primary-region";
    readonly tag_key: "tag-key";
    readonly tag_value: "tag-value";
};
/**
 * @public
 */
export type FilterNameStringType = (typeof FilterNameStringType)[keyof typeof FilterNameStringType];
/**
 * @public
 * @enum
 */
export declare const StatusType: {
    readonly Failed: "Failed";
    readonly InProgress: "InProgress";
    readonly InSync: "InSync";
};
/**
 * @public
 */
export type StatusType = (typeof StatusType)[keyof typeof StatusType];
/**
 * @public
 * @enum
 */
export declare const SortByType: {
    readonly created_date: "created-date";
    readonly last_accessed_date: "last-accessed-date";
    readonly last_changed_date: "last-changed-date";
    readonly name: "name";
};
/**
 * @public
 */
export type SortByType = (typeof SortByType)[keyof typeof SortByType];
/**
 * @public
 * @enum
 */
export declare const SortOrderType: {
    readonly asc: "asc";
    readonly desc: "desc";
};
/**
 * @public
 */
export type SortOrderType = (typeof SortOrderType)[keyof typeof SortOrderType];
